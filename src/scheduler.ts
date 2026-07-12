/**
 * Scheduler: orchestrates loop command parsing, task firing, and adaptive rescheduling.
 *
 * Per-session scoping:
 *   - Every task is bound to a sessionID at creation time
 *   - Strict: cancel/pause/resume only operate on tasks in the current session
 *   - --all flag: bypass session filter for global operations
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { LoopTask } from "./types.js"
import { LoopStore } from "./store.js"
import { CronParser } from "./cron-parser.js"
import { Jitter } from "./jitter.js"

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

export class Scheduler {
  /** Set by index.js command.execute.before hook so subcommands know "current session". */
  currentSessionID: string | null = null

  /** Per-scheduler guard against concurrent fires of the same task (e.g. parallel tickers). */
  private inflight = new Set<string>()

  constructor(private opts: SchedulerOptions) {}

  /** Wire the current sessionID from index.ts. */
  setCurrentSession(sessionID: string | null): void {
    this.currentSessionID = sessionID
  }

  /**
   * Parse a /loop user command and dispatch.
   * Examples:
   *   "5m check the deploy"      → fixed 5m, prompt="check the deploy"
   *   "check the deploy"        → adaptive, prompt="check the deploy"
   *   ""                        → bare, read .opencode/loop.md or default maintenance
   *   "list [--all]"            → show tasks
   *   "cancel|stop <id> [--all]"→ cancel one
   *   "pause <id> [--all]"      → pause
   *   "resume <id> [--all]"     → resume
   *   "stop-all [--all]"        → cancel all (current session by default)
   */
  async handleUserCommand(
    args: string,
    directory: string,
    sessionID?: string | null
  ): Promise<CommandParseResult> {
    if (sessionID !== undefined) this.currentSessionID = sessionID
    const trimmed = args.trim()
    const tokens = trimmed.split(/\s+/)
    const allFlag = tokens.includes("--all")
    const head = tokens[0]?.toLowerCase()

    // === Management subcommands ===
    if (head === "cancel" || head === "stop") {
      const id = tokens[1]
      if (!id) return { message: "❌ 用法: /loop cancel <taskId> [--all]" }
      return this.handleCancel(id, allFlag)
    }
    if (head === "list" || head === "status") {
      const tasks = allFlag
        ? this.opts.store.list()
        : this.opts.store.listBySession(this.currentSessionID ?? "")
      return { message: this.formatTaskList(tasks, allFlag) }
    }
    if (head === "pause") {
      const id = tokens[1]
      if (!id) return { message: "❌ 用法: /loop pause <taskId> [--all]" }
      return this.handlePause(id, allFlag)
    }
    if (head === "resume") {
      const id = tokens[1]
      if (!id) return { message: "❌ 用法: /loop resume <taskId> [--all]" }
      return this.handleResume(id, allFlag)
    }
    if (head === "stop-all") {
      if (allFlag) {
        const n = await this.opts.store.cancelAll()
        return { message: `🛑 Cancelled ${n} task(s) across all sessions` }
      }
      const removed = await this.opts.store.cancelBySession(this.currentSessionID ?? "")
      return { message: `🛑 Cancelled ${removed} task(s) in current session` }
    }

    // === Create tasks (sessionID required) ===
    if (!sessionID) {
      return { message: "❌ /loop requires an active session context" }
    }

    // Case 1: bare /loop — read .opencode/loop.md or default maintenance
    if (!trimmed) {
      const prompt = this.loadDefaultPrompt(directory)
      const task = await this.opts.store.create({
        prompt,
        mode: "maintenance",
        adaptiveMaxMs: this.opts.adaptiveMaxMs,
        directory,
        source: "default",
        sessionID,
      })
      return {
        task,
        message: `🔁 Loop started (maintenance mode): task ${task.id} (session ${sessionID.slice(0, 8)}). Auto re-arms every ${this.opts.adaptiveMaxMs / 1000}s. Use \`/loop cancel ${task.id}\` to stop.`,
      }
    }

    // Case 2: try to extract a leading interval
    const { interval, rest } = this.opts.cron.extractInterval(trimmed)
    if (interval && rest.trim()) {
      const task = await this.opts.store.create({
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

    // Case 3: adaptive mode
    if (trimmed) {
      const task = await this.opts.store.create({
        prompt: trimmed,
        mode: "adaptive",
        adaptiveMinMs: this.opts.adaptiveMinMs,
        adaptiveMaxMs: this.opts.adaptiveMaxMs,
        directory,
        source: "user",
        sessionID,
      })
      return {
        task,
        message: `🔁 Loop started (adaptive ${this.opts.adaptiveMinMs / 1000}s–${this.opts.adaptiveMaxMs / 1000}s): "${trimmed.slice(0, 50)}${trimmed.length > 50 ? "..." : ""}" [id=${task.id}] [s=${sessionID.slice(0, 8)}]. Cancel: \`/loop cancel ${task.id}\``,
      }
    }

    return { message: "❌ Empty loop command" }
  }

  private handleCancel(id: string, allFlag: boolean): CommandParseResult | Promise<CommandParseResult> {
    const task = this.opts.store.get(id)
    if (!task) return { message: `❌ No task ${id}` }
    if (!allFlag && task.sessionID !== this.currentSessionID) {
      return {
        message: `❌ Task ${id} belongs to another session (${task.sessionID.slice(0, 8)}). Add \`--all\` to override.`,
      }
    }
    return this.opts.store.cancel(id).then((r) => ({
      message: r ? `🛑 Cancelled ${id}` : `❌ No task ${id}`,
    }))
  }

  private handlePause(id: string, allFlag: boolean): CommandParseResult | Promise<CommandParseResult> {
    const task = this.opts.store.get(id)
    if (!task) return { message: `❌ No task ${id}` }
    if (!allFlag && task.sessionID !== this.currentSessionID) {
      return {
        message: `❌ Task ${id} belongs to another session. Add \`--all\` to override.`,
      }
    }
    return this.opts.store.setPaused(id, true).then((r) => ({
      message: r ? `⏸ Paused ${id}` : `❌ No task ${id}`,
    }))
  }

  private async handleResume(id: string, allFlag: boolean): Promise<CommandParseResult> {
    const task = this.opts.store.get(id)
    if (!task) return { message: `❌ No task ${id}` }
    if (!allFlag && task.sessionID !== this.currentSessionID) {
      return {
        message: `❌ Task ${id} belongs to another session. Add \`--all\` to override.`,
      }
    }
    const r = await this.opts.store.setPaused(id, false)
    if (r && r.mode === "fixed" && r.intervalMs) {
      await this.rearmFixed(r)
    }
    return { message: r ? `▶ Resumed ${id}` : `❌ No task ${id}` }
  }

  formatTaskList(tasks: LoopTask[], showSession = false): string {
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
  }

  /** Load .opencode/loop.md from project or user dir, fallback to default maintenance */
  private loadDefaultPrompt(directory: string): string {
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
  }

  async getDueTasks(now: number = Date.now()): Promise<LoopTask[]> {
    return this.opts.store.getDueTasks(now)
  }

  async getDueTasksForSession(sessionID: string, now: number = Date.now()): Promise<LoopTask[]> {
    return this.opts.store.getDueTasksForSession(sessionID, now)
  }

  /** Compute next fire time for a task after firing. Includes jitter for fixed mode. */
  async nextDueAt(task: LoopTask, now: number = Date.now()): Promise<number> {
    if (task.mode === "fixed" && task.intervalMs) {
      const jitter = this.opts.jitter.compute(task.id, task.intervalMs, now)
      return now + task.intervalMs + jitter
    }
    if (task.mode === "maintenance" && task.adaptiveMaxMs) {
      return now + task.adaptiveMaxMs
    }
    if (task.mode === "adaptive" && task.adaptiveMaxMs) {
      return now + task.adaptiveMaxMs
    }
    return now + 60_000
  }

  /**
   * Fire a task by sending it as a real message to its bound session.
   * Uses task.sessionID (NOT a passed-in override) to guarantee per-session delivery.
   * Concurrent calls for the same task.id are de-duplicated via the inflight Set.
   */
  async fireTask(task: LoopTask, ctx: any): Promise<void> {
    if (this.inflight.has(task.id)) {
      // Another concurrent fire is already in progress; skip to avoid double-firing.
      return
    }
    this.inflight.add(task.id)
    try {
      const sessionID = task.sessionID
      const text = task.prompt
      const directory = task.directory || ctx?.directory || process.cwd()
      const client = ctx?.client

      if (!sessionID) {
        console.warn(`[opencode-plugin-loop] task ${task.id} has no sessionID; skipping`)
        await this.opts.store.logFire(task, false)
        return
      }

      if (!client?.session?.prompt) {
        console.warn(`[opencode-plugin-loop] client.session.prompt not available`)
        await this.opts.store.logFire(task, false)
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
        await this.opts.store.logFire(task, true)
      } catch (err) {
        await this.opts.store.logFire(task, false)
        console.warn(`[opencode-plugin-loop] failed to fire task ${task.id}:`, err)
      }
    } finally {
      this.inflight.delete(task.id)
    }
  }

  /** For fixed mode: re-arm next fire */
  async rearmFixed(task: LoopTask, now: number = Date.now()): Promise<void> {
    if (!task.intervalMs) return
    const jitterMs = this.opts.jitter.compute(task.id, task.intervalMs, now)
    await this.opts.store.reschedule(task.id, now + task.intervalMs + jitterMs)
  }

  /** For adaptive mode: clamp to bounds */
  clampAdaptive(ms: number): number {
    return Math.max(this.opts.adaptiveMinMs, Math.min(this.opts.adaptiveMaxMs, ms))
  }
}

/**
 * Default maintenance prompt — mirrors Claude Code's built-in.
 */
export const DEFAULT_MAINTENANCE_PROMPT = `Continue any unfinished work from this conversation. Tend to the current branch's pull request: review comments, failed CI runs, merge conflicts. Run cleanup passes such as bug hunts or simplification when nothing else is pending.

Do not start new initiatives outside the above scope. Irreversible actions such as pushing or deleting only proceed when they continue something the transcript already authorized. After completing the work, call loop_schedule(action="cancel", taskId="<your id>") to end the loop, or call loop_schedule(action="reschedule", taskId="<your id>", nextDueAtMs=<pick a value between 60000 and 3600000>) to continue.`