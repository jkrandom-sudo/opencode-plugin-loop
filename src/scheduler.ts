/**
 * Scheduler: orchestrates loop command parsing, task firing, and adaptive rescheduling.
 *
 * Per-session scoping (matching Claude Code's /loop):
 *   - Every task is bound to a sessionID at creation time
 *   - list/cancel/pause/resume/stop only operate on tasks in the current session
 *   - Tasks from other sessions are invisible to management commands
 *
 * Implementation note: factory pattern (no `this` reliance) so opencode's
 * plugin loader can call us with or without `new`.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { LoopTask } from "./types.js"
import type { LoopStoreInstance as LoopStore } from "./store.js"
import type { CronParserInstance as CronParser } from "./cron-parser.js"
import type { JitterInstance as Jitter } from "./jitter.js"
import { buildFixedExecutionPrompt, buildLoopCreatedPrompt, errorMessage, type LoopLogger } from "./runtime-feedback.js"
import {
  buildAdaptiveExecutionPrompt,
  clampAdaptiveNextDueAt as clampAdaptivePolicyNextDueAt,
  randomAdaptiveNextDueAt,
} from "./adaptive-policy.js"

export interface SchedulerOptions {
  store: LoopStore
  cron: CronParser
  jitter: Jitter
  adaptiveMinMs: number
  adaptiveMaxMs: number
  defaultJitterEnabled?: boolean
  logger?: LoopLogger
  random?: () => number
}

export interface CommandParseResult {
  message: string
  task?: LoopTask
  /** Replacement prompt for the current model turn (natural Adaptive creation only). */
  modelPrompt?: string
}

interface SchedulerInstance {
  opts: SchedulerOptions
  currentSessionID: string | null
  inflight: Set<string>
  setCurrentSession(sessionID: string | null): void
  handleUserCommand(args: string, directory: string, sessionID?: string | null): Promise<CommandParseResult>
  handleCancel(id: string): CommandParseResult | Promise<CommandParseResult>
  handlePause(id: string): CommandParseResult | Promise<CommandParseResult>
  handleResume(id: string): Promise<CommandParseResult>
  formatTaskList(tasks: LoopTask[]): string
  loadDefaultPrompt(directory: string): string
  getDueTasks(now?: number): Promise<LoopTask[]>
  getDueTasksForSession(sessionID: string, now?: number): Promise<LoopTask[]>
  nextDueAt(task: LoopTask, now?: number): Promise<number>
  executeTask(task: LoopTask, ctx: any, now?: number): Promise<void>
  fireTask(task: LoopTask, ctx: any): Promise<boolean>
  rearmFixed(task: LoopTask, now?: number): Promise<void>
  rearmAdaptive(task: LoopTask, now?: number): Promise<void>
  adaptiveNextDueAt(task: LoopTask, now?: number): number
  clampAdaptiveNextDueAt(task: LoopTask, requestedAt: number, now?: number): number
  clampAdaptive(ms: number): number
}

export type { SchedulerInstance }

/**
 * Parse scheduling flags ONLY in the leading option-prefix region of `text`.
 * Scanning stops at the first non-flag token or at a `--` terminator; the
 * remainder is returned as the original substring (whitespace and newlines
 * preserved), so prompt text that merely looks like a flag (`--once`,
 * `--jitter=*`) is never stripped from the prompt body.
 */
const PREFIX_FLAGS = new Set(["--once", "--jitter=true", "--jitter=false"])

function parseFlagPrefix(text: string): {
  once: boolean
  jitterEnabled?: boolean
  prompt: string
} {
  let rest = text
  let once = false
  let jitterEnabled: boolean | undefined
  for (;;) {
    const m = /^\s*(\S+)/.exec(rest)
    if (!m) return { once, jitterEnabled, prompt: "" }
    const token = m[1]
    if (token === "--") {
      return { once, jitterEnabled, prompt: rest.slice(m[0].length).trim() }
    }
    if (!PREFIX_FLAGS.has(token)) {
      return { once, jitterEnabled, prompt: rest.trim() }
    }
    if (token === "--once") once = true
    else jitterEnabled = token === "--jitter=true"
    rest = rest.slice(m[0].length)
  }
}

/** Strip one layer of matching surrounding quotes (B10). */
export function stripOuterQuotes(text: string): string {
  const t = text.trim()
  if (t.length >= 2) {
    const first = t[0]
    const last = t[t.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1).trim()
    }
  }
  return t
}

/** Claude Code-style flags accepted as subcommand aliases (P-1). */
const CC_FLAG_MAP: Record<string, string> = {
  "--cancel": "cancel",
  "--stop": "stop",
  "--list": "list",
  "--status": "status",
  "--pause": "pause",
  "--resume": "resume",
  "--stop-all": "stop-all",
}

/** Flags that are meaningful in command position (not errors when leading). */
const LEADING_OK = new Set(["--jitter=true", "--jitter=false", "--once", "--"])

/** crude cron-expression detector (five-field crontab syntax) (B9). */
function looksLikeCron(tokens: string[]): boolean {
  if (tokens.length < 5) return false
  return tokens.slice(0, 5).every((t) => /^[\d*,/\-]+$/.test(t) && /[*,/\-]|\d/.test(t))
}

export const LOOP_HELP = `/loop — run prompts on a schedule

Usage:
  /loop <prompt>                    Adaptive: runs now, the model picks the next check (fallback 1m–1h)
  /loop <interval> <prompt>         Fixed interval: 30s, 5m, 2h, 1d (min 1s)
  /loop                             Maintenance mode (uses .opencode/loop.md when present)
  /loop help                        Show this help

Subcommands (tasks are bound to the session that created them):
  list | status                     Show this session's loop tasks
  cancel <id>                       Cancel one task
  stop [<id>]                       Cancel one task, or every task in this session when no id is given
  pause <id>                        Pause one task
  resume <id>                       Resume one task
  stop-all                          Cancel all tasks in this session

Flags (recognized only before the prompt begins; use -- to force the rest
to be treated as prompt text verbatim):
  --jitter=true|false               Force Jitter on/off for a fixed task
  --once                            Fire once, then auto-cancel (fixed tasks only)

Claude Code-style flags are accepted too: --cancel, --list, --status,
--pause, --resume, --stop, --stop-all map to the matching subcommand.

Examples:
  /loop 5m check the deploy status
  /loop 30s --once remind me to stretch
  /loop every two minutes check CI
  /loop cancel a1b2c3d4`

export function Scheduler(this: unknown, opts: SchedulerOptions): SchedulerInstance {
  void this
  const logger: LoopLogger = opts.logger ?? (async () => {})
  const random = opts.random ?? Math.random
  const inst: SchedulerInstance = {
    opts,
    currentSessionID: null,
    inflight: new Set<string>(),

    setCurrentSession(sessionID) {
      inst.currentSessionID = sessionID
    },

    async handleUserCommand(args, directory, sessionID) {
      if (sessionID !== undefined) inst.currentSessionID = sessionID
      const trimmed = stripOuterQuotes(args.trim())
      const tokens = trimmed === "" ? [] : trimmed.split(/\s+/)
      let head = tokens[0]?.toLowerCase()

      // Claude Code-style leading flags map to subcommands (P-1).
      if (head && CC_FLAG_MAP[head]) {
        head = CC_FLAG_MAP[head]
        tokens[0] = head
      } else if (head === "help" || head === "--help" || head === "-h") {
        return { message: LOOP_HELP }
      } else if (head?.startsWith("--") && !LEADING_OK.has(head)) {
        return {
          message: `❌ Unknown flag "${tokens[0]}". Run \`/loop help\` to see usage.`,
        }
      }

      if (head === "cancel" || head === "stop") {
        const id = tokens[1]
        if (!id) {
          if (head === "cancel") return { message: "❌ Usage: /loop cancel <taskId>" }
          // Bare `/loop stop`: cancel every task in this session.
          const removed = await inst.opts.store.cancelBySession(inst.currentSessionID ?? "")
          return { message: `🛑 Cancelled ${removed} task(s) in current session` }
        }
        return inst.handleCancel(id)
      }
      if (head === "list" || head === "status") {
        const tasks = inst.opts.store.listBySession(inst.currentSessionID ?? "")
        return { message: inst.formatTaskList(tasks) }
      }
      if (head === "pause") {
        const id = tokens[1]
        if (!id) return { message: "❌ Usage: /loop pause <taskId>" }
        return inst.handlePause(id)
      }
      if (head === "resume") {
        const id = tokens[1]
        if (!id) return { message: "❌ Usage: /loop resume <taskId>" }
        return inst.handleResume(id)
      }
      if (head === "stop-all") {
        const removed = await inst.opts.store.cancelBySession(inst.currentSessionID ?? "")
        return { message: `🛑 Cancelled ${removed} task(s) in current session` }
      }

      if (!sessionID) {
        return { message: "❌ /loop requires an active session context" }
      }

      if (!trimmed) {
        const prompt = inst.loadDefaultPrompt(directory)
        const task = await inst.opts.store.create({
          prompt,
          mode: "maintenance",
          adaptiveMaxMs: inst.opts.adaptiveMaxMs,
          directory,
          source: "default",
          sessionID,
        })
        // Run the maintenance prompt immediately in this turn (matching
        // Adaptive's run-now behavior), then re-arm on the slow cycle.
        await inst.opts.store.markFired(task.id, Date.now() + inst.opts.adaptiveMaxMs)
        return {
          task,
          modelPrompt: prompt,
          message: `🔁 Loop started (maintenance mode): task ${task.id} (session ${sessionID.slice(0, 8)}). Running now; then re-arms every ${inst.opts.adaptiveMaxMs / 1000}s. Use \`/loop cancel ${task.id}\` to stop.`,
        }
      }

      const { interval, rest } = inst.opts.cron.extractInterval(trimmed)
      if (interval) {
        const flags = parseFlagPrefix(rest)
        if (!flags.prompt) {
          return {
            message: `❌ Missing prompt after interval "${tokens[0]}". Usage: /loop <interval> <prompt> — see \`/loop help\`.`,
          }
        }
        const task = await inst.opts.store.create({
          prompt: flags.prompt,
          mode: "fixed",
          intervalMs: interval.ms,
          jitterEnabled: flags.jitterEnabled ?? inst.opts.defaultJitterEnabled ?? true,
          once: flags.once || undefined,
          directory,
          source: "user",
          sessionID,
        })
        return {
          task,
          modelPrompt: buildLoopCreatedPrompt({
            prompt: flags.prompt,
            schedule: `every ${interval.display}`,
            taskId: task.id,
            once: task.once,
          }),
          message: `🔁 Loop started: every ${interval.display}, prompt "${flags.prompt.slice(0, 50)}${flags.prompt.length > 50 ? "..." : ""}" [id=${task.id}] [s=${sessionID.slice(0, 8)}]${task.once ? " (runs once)" : ""}. Cancel: \`/loop cancel ${task.id}\``,
        }
      }

      // Reject inputs that look like scheduling syntax but are not supported,
      // instead of silently creating an Adaptive task out of them.
      if (looksLikeCron(tokens)) {
        return {
          message: `❌ Cron expressions are not supported. Use an interval like \`5m\` instead, e.g. \`/loop 5m ${tokens.slice(5).join(" ") || "check the build"}\`.`,
        }
      }
      if (/^\d/.test(tokens[0] ?? "")) {
        return {
          message: `❌ Invalid interval "${tokens[0]}". Use <number>s/m/h/d (min 1s), e.g. 30s, 5m, 2h, 1d — see \`/loop help\`.`,
        }
      }

      if (trimmed) {
        // Flags are recognized only in the leading option prefix; everything
        // after the first non-flag token (or `--`) is the prompt, verbatim.
        const flags = parseFlagPrefix(trimmed)
        if (!flags.prompt) {
          return { message: "❌ Empty loop command — see `/loop help`." }
        }
        if (flags.once) {
          return { message: "❌ --once is only supported for fixed-interval tasks, e.g. `/loop 30s --once <prompt>`." }
        }
        const task = await inst.opts.store.create({
          prompt: flags.prompt,
          mode: "adaptive",
          adaptiveMinMs: inst.opts.adaptiveMinMs,
          adaptiveMaxMs: inst.opts.adaptiveMaxMs,
          directory,
          source: "user",
          sessionID,
        })
        await inst.rearmAdaptive(task)
        await inst.opts.store.markFired(task.id, task.nextDueAt)
        return {
          task,
          modelPrompt: buildAdaptiveExecutionPrompt(task, {
            minMs: inst.opts.adaptiveMinMs,
            maxMs: inst.opts.adaptiveMaxMs,
          }),
          message: `🔁 Loop started (adaptive ${inst.opts.adaptiveMinMs / 1000}s–${inst.opts.adaptiveMaxMs / 1000}s): "${flags.prompt.slice(0, 50)}${flags.prompt.length > 50 ? "..." : ""}" [id=${task.id}] [s=${sessionID.slice(0, 8)}]. Cancel: \`/loop cancel ${task.id}\``,
        }
      }

      return { message: "❌ Empty loop command — see `/loop help`." }
    },

    handleCancel(id) {
      const task = inst.opts.store.get(id)
      if (!task || task.sessionID !== inst.currentSessionID) {
        return { message: `❌ No task ${id} in this session` }
      }
      return inst.opts.store.cancel(id).then((r) => ({
        message: r ? `🛑 Cancelled ${id}` : `❌ No task ${id} in this session`,
      }))
    },

    handlePause(id) {
      const task = inst.opts.store.get(id)
      if (!task || task.sessionID !== inst.currentSessionID) {
        return { message: `❌ No task ${id} in this session` }
      }
      return inst.opts.store.setPaused(id, true).then((r) => ({
        message: r ? `⏸ Paused ${id}` : `❌ No task ${id} in this session`,
      }))
    },

    async handleResume(id) {
      const task = inst.opts.store.get(id)
      if (!task || task.sessionID !== inst.currentSessionID) {
        return { message: `❌ No task ${id} in this session` }
      }
      const r = await inst.opts.store.setPaused(id, false)
      if (r) {
        // Re-arm per mode (B6): without this, adaptive/maintenance tasks keep
        // a stale nextDueAt and catch-up fire immediately on resume.
        if (r.mode === "fixed" && r.intervalMs) {
          await inst.rearmFixed(r)
        } else if (r.mode === "adaptive") {
          await inst.rearmAdaptive(r)
        } else if (r.mode === "maintenance" && r.adaptiveMaxMs) {
          await inst.opts.store.reschedule(r.id, Date.now() + r.adaptiveMaxMs)
        }
      }
      return { message: r ? `▶ Resumed ${id}` : `❌ No task ${id} in this session` }
    },

    formatTaskList(tasks) {
      if (tasks.length === 0)
        return "📭 No loop tasks. Use `/loop <prompt>` or `/loop 5m <prompt>` to create one."
      const lines = [`📋 ${tasks.length} loop task(s):`]
      for (const t of tasks) {
        const interval =
          t.mode === "fixed"
            ? `every ${(t.intervalMs ?? 0) / 1000}s`
            : t.mode === "adaptive"
              ? `adaptive ${(t.adaptiveMinMs ?? 0) / 1000}s–${(t.adaptiveMaxMs ?? 0) / 1000}s`
              : `maintenance ${(t.adaptiveMaxMs ?? 0) / 1000}s`
        const status = t.paused ? "⏸ paused" : "▶ active"
        const onceTag = t.once ? " • once" : ""
        const preview = t.prompt.length > 60 ? t.prompt.slice(0, 60) + "..." : t.prompt
        lines.push(`  [${t.id}] ${status} • ${interval}${onceTag} • ${preview}`)
      }
      lines.push(
        `Manage: \`/loop cancel|pause|resume <id>\` or \`/loop stop-all\``
      )
      return lines.join("\n")
    },

    loadDefaultPrompt(directory) {
      const candidates = [
        join(directory, ".opencode", "loop.md"),
        join(directory, "loop.md"),
      ]
      for (const p of candidates) {
        if (existsSync(p)) {
          try {
            const content = readFileSync(p, "utf-8").trim()
            if (content) return content
          } catch {
            // ignore
          }
        }
      }
      return DEFAULT_MAINTENANCE_PROMPT
    },

    async getDueTasks(now: number = Date.now()) {
      return inst.opts.store.getDueTasks(now)
    },

    async getDueTasksForSession(sessionID: string, now: number = Date.now()) {
      return inst.opts.store.getDueTasksForSession(sessionID, now)
    },

    async nextDueAt(task, now: number = Date.now()) {
      if (task.mode === "fixed" && task.intervalMs) {
        const jitter =
          task.jitterEnabled === false
            ? 0
            : inst.opts.jitter.compute(task.id, task.intervalMs, now)
        return now + task.intervalMs + jitter
      }
      if (task.mode === "maintenance" && task.adaptiveMaxMs) {
        return now + task.adaptiveMaxMs
      }
      if (task.mode === "adaptive" && task.adaptiveMaxMs) {
        return inst.adaptiveNextDueAt(task, now)
      }
      return now + 60_000
    },

    async executeTask(task, ctx, now) {
      if (task.mode === "adaptive") {
        const fallbackNextDueAt = randomAdaptiveNextDueAt(
          task,
          { minMs: inst.opts.adaptiveMinMs, maxMs: inst.opts.adaptiveMaxMs },
          random,
          now ?? Date.now()
        )
        await inst.opts.store.markFired(task.id, fallbackNextDueAt)
        await inst.fireTask(task, ctx)
        return
      }

      // Wall-clock scheduling: the next cycle is anchored to when this fire
      // STARTED, so long-running model turns do not inflate the interval.
      const fireStartedAt = now ?? Date.now()
      const fired = await inst.fireTask(task, ctx)
      // One-shot tasks end after their first successful fire (P-4).
      if (task.once && fired) {
        await inst.opts.store.cancel(task.id)
        return
      }
      const next = await inst.nextDueAt(task, fireStartedAt)
      await inst.opts.store.markFired(task.id, next)
    },

    async fireTask(task, ctx) {
      if (inst.inflight.has(task.id)) return false
      inst.inflight.add(task.id)
      try {
        const sessionID = task.sessionID
        const text =
          task.mode === "adaptive"
            ? buildAdaptiveExecutionPrompt(task, {
                minMs: inst.opts.adaptiveMinMs,
                maxMs: inst.opts.adaptiveMaxMs,
              })
            : buildFixedExecutionPrompt(task)
        const directory = task.directory || ctx?.directory || process.cwd()
        const client = ctx?.client

        if (!sessionID) {
          await logger("warn", "task has no sessionID; skipping", { taskId: task.id })
          await inst.opts.store.logFire(task, false)
          return false
        }
        if (!client?.session?.prompt) {
          await logger("warn", "client.session.prompt not available", { taskId: task.id })
          await inst.opts.store.logFire(task, false)
          return false
        }
        try {
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [
                {
                  type: "text",
                  text,
                  synthetic: true,
                  metadata: { loopTaskId: task.id, loopMode: task.mode },
                },
              ],
            },
            query: { directory },
          })
          await inst.opts.store.logFire(task, true)
          return true
        } catch (err) {
          await inst.opts.store.logFire(task, false)
          await logger("error", "failed to fire task", {
            taskId: task.id,
            error: errorMessage(err),
          })
          return false
        }
      } finally {
        inst.inflight.delete(task.id)
      }
    },

    async rearmFixed(task, now: number = Date.now()) {
      if (!task.intervalMs) return
      const jitterMs =
        task.jitterEnabled === false
          ? 0
          : inst.opts.jitter.compute(task.id, task.intervalMs, now)
      await inst.opts.store.reschedule(task.id, now + task.intervalMs + jitterMs)
    },

    async rearmAdaptive(task, now: number = Date.now()) {
      if (task.mode !== "adaptive") return
      await inst.opts.store.reschedule(task.id, inst.adaptiveNextDueAt(task, now))
    },

    adaptiveNextDueAt(task, now: number = Date.now()) {
      return randomAdaptiveNextDueAt(
        task,
        { minMs: inst.opts.adaptiveMinMs, maxMs: inst.opts.adaptiveMaxMs },
        random,
        now
      )
    },

    clampAdaptiveNextDueAt(task, requestedAt, now: number = Date.now()) {
      return clampAdaptivePolicyNextDueAt(
        task,
        { minMs: inst.opts.adaptiveMinMs, maxMs: inst.opts.adaptiveMaxMs },
        requestedAt,
        now
      )
    },

    clampAdaptive(ms) {
      return Math.max(inst.opts.adaptiveMinMs, Math.min(inst.opts.adaptiveMaxMs, ms))
    },
  }

  return inst
}

/**
 * Default maintenance prompt — mirrors Claude Code's built-in.
 */
export const DEFAULT_MAINTENANCE_PROMPT = `Continue any unfinished work from this conversation. Tend to the current branch's pull request: review comments, failed CI runs, merge conflicts. Run cleanup passes such as bug hunts or simplification when nothing else is pending.

Do not start new initiatives outside the above scope. Irreversible actions such as pushing or deleting only proceed when they continue something the transcript already authorized. After completing the work, call loop_schedule(action="cancel", taskId="<your id>") to end the loop, or call loop_schedule(action="reschedule", taskId="<your id>", delayMs=<a relative delay between 60000 and 3600000>) to continue.`
