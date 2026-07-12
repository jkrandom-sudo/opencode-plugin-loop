/**
 * Scheduler: orchestrates loop command parsing, task firing, and adaptive rescheduling.
 *
 * Per-session scoping:
 *   - Every task is bound to a sessionID at creation time
 *   - Strict: cancel/pause/resume only operate on tasks in the current session
 *   - --all flag: bypass session filter for global operations
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

export interface SchedulerOptions {
  store: LoopStore
  cron: CronParser
  jitter: Jitter
  adaptiveMinMs: number
  adaptiveMaxMs: number
}

export interface CommandParseResult {
  message: string
  task?: LoopTask
}

interface SchedulerInstance {
  opts: SchedulerOptions
  currentSessionID: string | null
  inflight: Set<string>
  setCurrentSession(sessionID: string | null): void
  handleUserCommand(args: string, directory: string, sessionID?: string | null): Promise<CommandParseResult>
  handleCancel(id: string, allFlag: boolean): CommandParseResult | Promise<CommandParseResult>
  handlePause(id: string, allFlag: boolean): CommandParseResult | Promise<CommandParseResult>
  handleResume(id: string, allFlag: boolean): Promise<CommandParseResult>
  formatTaskList(tasks: LoopTask[], showSession?: boolean): string
  loadDefaultPrompt(directory: string): string
  getDueTasks(now?: number): Promise<LoopTask[]>
  getDueTasksForSession(sessionID: string, now?: number): Promise<LoopTask[]>
  nextDueAt(task: LoopTask, now?: number): Promise<number>
  fireTask(task: LoopTask, ctx: any): Promise<void>
  rearmFixed(task: LoopTask, now?: number): Promise<void>
  clampAdaptive(ms: number): number
}

export type { SchedulerInstance }

export function Scheduler(this: unknown, opts: SchedulerOptions): SchedulerInstance {
  void this
  const inst: SchedulerInstance = {
    opts,
    currentSessionID: null,
    inflight: new Set<string>(),

    setCurrentSession(sessionID) {
      inst.currentSessionID = sessionID
    },

    async handleUserCommand(args, directory, sessionID) {
      if (sessionID !== undefined) inst.currentSessionID = sessionID
      const trimmed = args.trim()
      const tokens = trimmed.split(/\s+/)
      const allFlag = tokens.includes("--all")
      const head = tokens[0]?.toLowerCase()

      if (head === "cancel" || head === "stop") {
        const id = tokens[1]
        if (!id) return { message: "❌ 用法: /loop cancel <taskId> [--all]" }
        return inst.handleCancel(id, allFlag)
      }
      if (head === "list" || head === "status") {
        const tasks = allFlag
          ? inst.opts.store.list()
          : inst.opts.store.listBySession(inst.currentSessionID ?? "")
        return { message: inst.formatTaskList(tasks, allFlag) }
      }
      if (head === "pause") {
        const id = tokens[1]
        if (!id) return { message: "❌ 用法: /loop pause <taskId> [--all]" }
        return inst.handlePause(id, allFlag)
      }
      if (head === "resume") {
        const id = tokens[1]
        if (!id) return { message: "❌ 用法: /loop resume <taskId> [--all]" }
        return inst.handleResume(id, allFlag)
      }
      if (head === "stop-all") {
        if (allFlag) {
          const n = await inst.opts.store.cancelAll()
          return { message: `🛑 Cancelled ${n} task(s) across all sessions` }
        }
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
        return {
          task,
          message: `🔁 Loop started (maintenance mode): task ${task.id} (session ${sessionID.slice(0, 8)}). Auto re-arms every ${inst.opts.adaptiveMaxMs / 1000}s. Use \`/loop cancel ${task.id}\` to stop.`,
        }
      }

      const { interval, rest } = inst.opts.cron.extractInterval(trimmed)
      if (interval && rest.trim()) {
        const task = await inst.opts.store.create({
          prompt: rest.trim(),
          mode: "fixed",
          intervalMs: interval.ms,
          directory,
          source: "user",
          sessionID,
        })
        return {
          task,
          message: `🔁 Loop started: every ${interval.display}, prompt "${rest.trim().slice(0, 50)}${rest.length > 50 ? "..." : ""}" [id=${task.id}] [s=${sessionID.slice(0, 8)}]. Cancel: \`/loop cancel ${task.id}\``,
        }
      }

      if (trimmed) {
        const task = await inst.opts.store.create({
          prompt: trimmed,
          mode: "adaptive",
          adaptiveMinMs: inst.opts.adaptiveMinMs,
          adaptiveMaxMs: inst.opts.adaptiveMaxMs,
          directory,
          source: "user",
          sessionID,
        })
        return {
          task,
          message: `🔁 Loop started (adaptive ${inst.opts.adaptiveMinMs / 1000}s–${inst.opts.adaptiveMaxMs / 1000}s): "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "..." : ""}" [id=${task.id}] [s=${sessionID.slice(0, 8)}]. Cancel: \`/loop cancel ${task.id}\``,
        }
      }

      return { message: "❌ Empty loop command" }
    },

    handleCancel(id, allFlag) {
      const task = inst.opts.store.get(id)
      if (!task) return { message: `❌ No task ${id}` }
      if (!allFlag && task.sessionID !== inst.currentSessionID) {
        return {
          message: `❌ Task ${id} belongs to another session (${task.sessionID.slice(0, 8)}). Add \`--all\` to override.`,
        }
      }
      return inst.opts.store.cancel(id).then((r) => ({
        message: r ? `🛑 Cancelled ${id}` : `❌ No task ${id}`,
      }))
    },

    handlePause(id, allFlag) {
      const task = inst.opts.store.get(id)
      if (!task) return { message: `❌ No task ${id}` }
      if (!allFlag && task.sessionID !== inst.currentSessionID) {
        return {
          message: `❌ Task ${id} belongs to another session. Add \`--all\` to override.`,
        }
      }
      return inst.opts.store.setPaused(id, true).then((r) => ({
        message: r ? `⏸ Paused ${id}` : `❌ No task ${id}`,
      }))
    },

    async handleResume(id, allFlag) {
      const task = inst.opts.store.get(id)
      if (!task) return { message: `❌ No task ${id}` }
      if (!allFlag && task.sessionID !== inst.currentSessionID) {
        return {
          message: `❌ Task ${id} belongs to another session. Add \`--all\` to override.`,
        }
      }
      const r = await inst.opts.store.setPaused(id, false)
      if (r && r.mode === "fixed" && r.intervalMs) {
        await inst.rearmFixed(r)
      }
      return { message: r ? `▶ Resumed ${id}` : `❌ No task ${id}` }
    },

    formatTaskList(tasks, showSession = false) {
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
        const sessionTag =
          showSession && t.sessionID ? ` [s:${t.sessionID.slice(0, 8)}]` : ""
        const preview = t.prompt.length > 60 ? t.prompt.slice(0, 60) + "..." : t.prompt
        lines.push(`  [${t.id}]${sessionTag} ${status} • ${interval} • ${preview}`)
      }
      lines.push(
        `Manage: \`/loop cancel|pause|resume <id>\` (add \`--all\` to cross sessions) or \`/loop stop-all\``
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
        const jitter = inst.opts.jitter.compute(task.id, task.intervalMs, now)
        return now + task.intervalMs + jitter
      }
      if (task.mode === "maintenance" && task.adaptiveMaxMs) {
        return now + task.adaptiveMaxMs
      }
      if (task.mode === "adaptive" && task.adaptiveMaxMs) {
        return now + task.adaptiveMaxMs
      }
      return now + 60_000
    },

    async fireTask(task, ctx) {
      if (inst.inflight.has(task.id)) return
      inst.inflight.add(task.id)
      try {
        const sessionID = task.sessionID
        const text = task.prompt
        const directory = task.directory || ctx?.directory || process.cwd()
        const client = ctx?.client

        if (!sessionID) {
          console.warn(`[opencode-plugin-loop] task ${task.id} has no sessionID; skipping`)
          await inst.opts.store.logFire(task, false)
          return
        }
        if (!client?.session?.prompt) {
          console.warn(`[opencode-plugin-loop] client.session.prompt not available`)
          await inst.opts.store.logFire(task, false)
          return
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
        } catch (err) {
          await inst.opts.store.logFire(task, false)
          console.warn(`[opencode-plugin-loop] failed to fire task ${task.id}:`, err)
        }
      } finally {
        inst.inflight.delete(task.id)
      }
    },

    async rearmFixed(task, now: number = Date.now()) {
      if (!task.intervalMs) return
      const jitterMs = inst.opts.jitter.compute(task.id, task.intervalMs, now)
      await inst.opts.store.reschedule(task.id, now + task.intervalMs + jitterMs)
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

Do not start new initiatives outside the above scope. Irreversible actions such as pushing or deleting only proceed when they continue something the transcript already authorized. After completing the work, call loop_schedule(action="cancel", taskId="<your id>") to end the loop, or call loop_schedule(action="reschedule", taskId="<your id>", nextDueAtMs=<pick a value between 60000 and 3600000>) to continue.`