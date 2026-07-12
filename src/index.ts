/**
 * opencode-plugin-loop — main entry point
 *
 * Implements the `/loop` command for opencode, modeled after Claude Code's `/loop`.
 *
 * Usage:
 *   /loop 5m check if the deploy finished   — fixed interval (in current session)
 *   /loop check the deploy status           — adaptive interval (1min–1hr)
 *   /loop                                  — bare: read .opencode/loop.md or default maintenance
 *
 * Subcommands (all session-scoped; add `--all` to cross sessions):
 *   /loop list | status [--all]            — show tasks
 *   /loop cancel | stop <id> [--all]       — cancel one
 *   /loop pause <id> [--all]               — pause one
 *   /loop resume <id> [--all]              — resume one
 *   /loop stop-all [--all]                 — cancel all
 *
 * Per-session architecture:
 *   - chat.message hook tracks the current active sessionID
 *   - command.execute.before also updates currentSessionID
 *   - 15s ticker fires ONLY tasks whose sessionID === currentSessionID
 *   - session.deleted event cancels all tasks for that session
 *   - On load, tasks without sessionID (legacy) are cleaned up
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { LoopStore } from "./store.js"
import { Scheduler } from "./scheduler.js"
import { CronParser } from "./cron-parser.js"
import { Jitter } from "./jitter.js"
import { buildLoopTools } from "./tools/loop-tools.js"
import type { LoopConfig } from "./types.js"

const DEFAULT_CONFIG: Required<LoopConfig> = {
  storageDir: "",
  maxTasks: 50,
  taskTtlDays: 7,
  jitterPercent: 0.1,
  defaultAdaptiveMinMs: 60_000,
  defaultAdaptiveMaxMs: 3_600_000,
  tickerIntervalMs: 5_000,
}

export const LoopPlugin: Plugin = async (ctx) => {
  const opts = (ctx as any).options as Partial<LoopConfig> | undefined
  const config = { ...DEFAULT_CONFIG, ...(opts ?? {}) }

  const storageDir = config.storageDir || `${ctx.directory}/.opencode/cache/loop`

  // Use factory functions directly (not `new`) to avoid opencode's plugin
  // loader eating the `new` keyword and breaking function constructors.
  const store = LoopStore({
    storageDir,
    maxTasks: config.maxTasks,
    taskTtlMs: config.taskTtlDays * 86_400_000,
  })
  await store.load()

  const cron = CronParser()
  const jitter = Jitter()
  const scheduler = Scheduler({
    store,
    cron,
    jitter,
    adaptiveMinMs: config.defaultAdaptiveMinMs,
    adaptiveMaxMs: config.defaultAdaptiveMaxMs,
  })

  // Track which session the user is currently in.
  // Updated by chat.message hook (every user message) and command.execute.before.
  let activeSessionID: string | null = null
  const setActive = (sid: string | null | undefined): void => {
    if (sid) activeSessionID = sid
  }

  // Internal ticker: every 15s, fire any due tasks whose sessionID matches the active session.
  // This replaces the old session.idle-event-driven firing and runs even when no user input.
  const inflight = new Set<string>()
  const ticker = setInterval(async () => {
    try {
      if (!activeSessionID) return
      const due = await scheduler.getDueTasksForSession(activeSessionID)
      if (due.length === 0) return
      for (const task of due) {
        if (task.sessionID !== activeSessionID) continue
        if (inflight.has(task.id)) continue
        inflight.add(task.id)
        try {
          await scheduler.fireTask(task, ctx)
          const next = await scheduler.nextDueAt(task)
          await store.markFired(task.id, next)
        } finally {
          inflight.delete(task.id)
        }
      }
    } catch (err) {
      console.warn(`[opencode-plugin-loop] ticker error:`, err)
    }
  }, config.tickerIntervalMs)

  const hooks: Hooks = {
    event: async ({ event }) => {
      const e = event as { type?: string; properties?: any; sessionID?: string }
      if (e.type === "session.compacted") {
        await store.load()
        return
      }
      if (e.type === "session.deleted") {
        const sid = e.properties?.sessionID ?? e.sessionID
        if (sid) {
          const n = await store.cancelBySession(sid)
          if (n > 0) {
            console.log(
              `[opencode-plugin-loop] cleaned ${n} task(s) for deleted session ${sid.slice(0, 8)}`
            )
          }
          if (activeSessionID === sid) activeSessionID = null
        }
        return
      }
    },

    "chat.message": async (input) => {
      setActive(input.sessionID)
    },

    "command.execute.before": async (input, _output) => {
      if (input.command !== "loop") return
      setActive(input.sessionID)
      const args = input.arguments || ""
      const result = await scheduler.handleUserCommand(args, ctx.directory, input.sessionID)
      console.log(`[opencode-plugin-loop] ${result.message}`)
    },
  }

  hooks.tool = await buildLoopTools(store, scheduler)
  ;(hooks as any)._ticker = ticker
  hooks.dispose = async () => {
    clearInterval(ticker)
  }

  return hooks
}

// Export both bare plugin function and {server: plugin} wrapper.
// opencode's plugin loader is picky about which format it accepts.
export default LoopPlugin
export const plugin = { server: LoopPlugin }

// ---- Public API exports (for users who want to compose) ----
export { LoopStore } from "./store.js"
export { Scheduler } from "./scheduler.js"
export { CronParser } from "./cron-parser.js"
export { Jitter } from "./jitter.js"
export * from "./types.js"