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
 * Subcommands (all scoped to the current session):
 *   /loop list | status                        — show tasks
 *   /loop cancel | stop <id>                   — cancel one
 *   /loop pause <id>                           — pause one
 *   /loop resume <id>                          — resume one
 *   /loop stop | stop-all                      — cancel all tasks in this session
 *
 * Per-session architecture:
 *   - chat.message hook tracks the current active sessionID
 *   - command.execute.before also updates currentSessionID
 *   - 5s ticker fires ONLY tasks whose sessionID === currentSessionID
 *   - session.deleted event cancels all tasks for that session
 *   - On load, tasks without sessionID (legacy) are cleaned up
 */

import type { Plugin, Hooks, PluginModule } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { LoopStore } from "./store.js"
import { InstanceLock } from "./instance-lock.js"
import { Scheduler, stripOuterQuotes } from "./scheduler.js"
import { CronParser } from "./cron-parser.js"
import { Jitter } from "./jitter.js"
import { buildLoopTools } from "./tools/loop-tools.js"
import type { LoopConfig } from "./types.js"
import {
  buildLoopFailedPrompt,
  buildLoopResultPrompt,
  consumeLoopCommand,
  createLoopLogger,
  errorMessage,
} from "./runtime-feedback.js"

const DEFAULT_CONFIG: Required<LoopConfig> = {
  storageDir: "",
  maxTasks: 50,
  taskTtlDays: 7,
  jitterPercent: 0.1,
  defaultAdaptiveMinMs: 60_000,
  defaultAdaptiveMaxMs: 3_600_000,
  tickerIntervalMs: 5_000,
  defaultJitterEnabled: true,
  ephemeralTasks: true,
  instanceLock: true,
}

function commandAction(args: string): string {
  const head = args.trim().split(/\s+/, 1)[0]?.toLowerCase()
  if (!head) return "maintenance"
  if (["list", "status", "cancel", "stop", "pause", "resume", "stop-all", "help"].includes(head)) {
    return head
  }
  return "schedule"
}

export const LoopPlugin: Plugin = async (ctx) => {
  const logger = createLoopLogger(ctx.client)
  const opts = (ctx as any).options as Partial<LoopConfig> | undefined
  const config = { ...DEFAULT_CONFIG, ...(opts ?? {}) }

  const storageDir = config.storageDir || `${ctx.directory}/.opencode/cache/loop`

  // Use factory functions directly (not `new`) to avoid opencode's plugin
  // loader eating the `new` keyword and breaking function constructors.
  const store = LoopStore({
    storageDir,
    maxTasks: config.maxTasks,
    taskTtlMs: config.taskTtlDays * 86_400_000,
    ephemeralTasks: config.ephemeralTasks,
    logger,
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
    defaultJitterEnabled: config.defaultJitterEnabled,
    logger,
  })

  // Track which session the user is currently in.
  // Updated by chat.message hook (every user message) and command.execute.before.
  let activeSessionID: string | null = null
  const sessionParents = new Map<string, string>()
  const rootSessionID = (sid: string): string => {
    const seen = new Set<string>()
    let current = sid
    while (sessionParents.has(current) && !seen.has(current)) {
      seen.add(current)
      current = sessionParents.get(current) as string
    }
    return current
  }
  const setActive = (sid: string | null | undefined): void => {
    if (sid) activeSessionID = rootSessionID(sid)
  }

  // Internal ticker: every 5s, fire any due tasks whose sessionID matches the active session.
  // This replaces the old session.idle-event-driven firing and runs even when no user input.
  // Firing requires lock.shouldFire(): the lock serializes same-process plugin
  // instances only — when the lock is held by ANOTHER process, that process
  // fires its own tasks and we fire ours (owner-pid filter below).
  const lock = InstanceLock({ storageDir, logger })
  const lockEnabled = config.instanceLock
  if (lockEnabled) lock.start()
  const inflight = new Set<string>()
  const ticker = setInterval(async () => {
    try {
      if (lockEnabled && !lock.shouldFire()) return
      if (!activeSessionID) return
      const due = await scheduler.getDueTasksForSession(activeSessionID)
      if (due.length === 0) return
      for (const task of due) {
        if (task.sessionID !== activeSessionID) continue
        // Tasks created by another live process are fired by that process.
        if (task.ownerPid !== undefined && task.ownerPid !== process.pid) continue
        if (inflight.has(task.id)) continue
        inflight.add(task.id)
        try {
          await scheduler.executeTask(task, ctx)
        } finally {
          inflight.delete(task.id)
        }
      }
    } catch (err) {
      await logger("error", "ticker error", { error: errorMessage(err) })
    }
  }, config.tickerIntervalMs)

  // Deterministic /loop handling shared by the command.execute.before hook
  // (TUI path) and the chat.message fallback below (opencode run path), so
  // every mode applies the exact same parsing and input guards.
  const runLoopCommand = async (
    args: string,
    sessionID: string | null | undefined,
    parts: Part[]
  ): Promise<void> => {
    setActive(sessionID)
    let result
    try {
      result = await scheduler.handleUserCommand(args, ctx.directory, sessionID)
    } catch (error) {
      result = { message: `❌ /loop failed: ${errorMessage(error)}` }
    }
    if (result.message.startsWith("❌") && !result.modelPrompt) {
      result.modelPrompt = buildLoopFailedPrompt(result.message)
    } else if (!result.modelPrompt) {
      result.modelPrompt = buildLoopResultPrompt(result.message)
    }
    consumeLoopCommand(parts, result.modelPrompt)
    await logger(result.message.startsWith("❌") ? "error" : "info", result.message, {
      sessionID,
      action: commandAction(args),
      argumentLength: args.length,
    })
  }

  const hooks: Hooks = {
    event: async ({ event }) => {
      const e = event as { type?: string; properties?: any; sessionID?: string }
      if (e.type === "session.created" || e.type === "session.updated") {
        const info = e.properties?.info
        if (info?.id && info?.parentID) sessionParents.set(info.id, info.parentID)
        return
      }
      if (e.type === "session.compacted") {
        await store.load()
        return
      }
      if (e.type === "session.deleted") {
        const sid = e.properties?.sessionID ?? e.properties?.info?.id ?? e.sessionID
        if (sid) {
          sessionParents.delete(sid)
          sessionParents.forEach((parent, child) => {
            if (parent === sid) sessionParents.delete(child)
          })
          const n = await store.cancelBySession(sid)
          if (n > 0) {
            await logger("info", `cleaned ${n} task(s) for deleted session`, {
              sessionID: sid,
              count: n,
            })
          }
          if (activeSessionID === sid) activeSessionID = null
        }
        return
      }
    },

    "chat.message": async (input, output) => {
      setActive(input.sessionID)
      // Run-mode fallback (issue #18): `opencode run` — headless and `-i` —
      // sends "/loop ..." as a plain user message via session.prompt and
      // never emits command.execute.before, so the raw $ARGUMENTS would go
      // straight to the model and every deterministic guard would be
      // bypassed. Intercept the literal command text here and run the same
      // deterministic parser. Parts already consumed by
      // command.execute.before are synthetic/ignored and skipped, so the
      // TUI path is never handled twice.
      //
      // Note: opencode run re-quotes argv elements that contain spaces, so
      // the stored text is often `"/loop 5m"` (with literal quotes) — strip
      // outer quotes before matching, mirroring handleUserCommand.
      for (const part of output?.parts ?? []) {
        if (part.type !== "text" || part.synthetic || part.ignored) continue
        const match = /^\/loop(?:\s+([\s\S]*))?$/.exec(stripOuterQuotes(part.text))
        if (!match) continue
        await runLoopCommand(match[1] ?? "", input.sessionID, output.parts)
        return
      }
    },

    "command.execute.before": async (input, output) => {
      if (input.command !== "loop") return
      await runLoopCommand(input.arguments || "", input.sessionID, output.parts)
    },
  }

  hooks.tool = await buildLoopTools(store, scheduler)
  ;(hooks as any)._ticker = ticker
  hooks.dispose = async () => {
    clearInterval(ticker)
    lock.stop()
  }

  return hooks
}

// OpenCode v1 detects the default {id, server} object before its legacy loader
// scans every named export. Keeping the factories below as named exports is
// therefore safe while preserving the package's public composition API.
export const plugin: PluginModule = {
  id: "opencode-plugin-loop",
  server: LoopPlugin,
}
export default plugin

// ---- Public API exports (for users who want to compose) ----
export { LoopStore } from "./store.js"
export { InstanceLock } from "./instance-lock.js"
export { Scheduler } from "./scheduler.js"
export { CronParser } from "./cron-parser.js"
export { Jitter } from "./jitter.js"
export * from "./types.js"
