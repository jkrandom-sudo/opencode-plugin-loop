/**
 * LLM-callable tools for the loop plugin.
 *
 * Two tools:
 *   - loop_schedule: create/list/cancel/reschedule/set_fixed/pause/resume
 *   - loop_status:   show running tasks + recent fire history
 *
 * Per-session scoping:
 *   - create binds task to ctx.sessionID (ToolContext)
 *   - list/status default to current session, with `all: true` to see all
 *   - cancel/pause/resume/reschedule/set_fixed are session-scoped unless `all: true`
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import type { LoopStoreInstance as LoopStore } from "../store.js"
import type { SchedulerInstance as Scheduler } from "../scheduler.js"

export async function buildLoopTools(
  store: LoopStore,
  scheduler: Scheduler
): Promise<Record<string, ToolDefinition>> {
  return {
    loop_schedule: tool({
      description:
        "Manage /loop tasks: create, list, cancel, pause, resume, reschedule, or convert an Adaptive task to Fixed. Each task is bound to the session that created it; pass all=true to cross session boundaries.",
      args: {
        action: z.enum(["create", "list", "cancel", "reschedule", "set_fixed", "pause", "resume"]),
        taskId: z.string().optional().describe("Required for cancel/reschedule/set_fixed/pause/resume"),
        prompt: z.string().optional().describe("Required for create; the prompt to re-inject each cycle"),
        intervalMs: z.number().finite().optional().describe("Fixed interval in milliseconds (for create+fixed mode or set_fixed)"),
        delayMs: z.number().finite().optional().describe("Relative delay in milliseconds (preferred for Adaptive reschedule)"),
        nextDueAtMs: z.number().finite().optional().describe("Absolute epoch ms for reschedule; cannot be combined with delayMs"),
        jitterEnabled: z.boolean().optional().describe("Fixed-task Jitter policy for create or set_fixed"),
        once: z.boolean().optional().describe("One-shot task: auto-cancel after the first successful fire (fixed mode only)"),
        mode: z
          .enum(["fixed", "adaptive", "maintenance"])
          .optional()
          .describe("Default: fixed if intervalMs set, else adaptive"),
        all: z
          .boolean()
          .optional()
          .describe("For list/cancel/reschedule/set_fixed/pause/resume: ignore session scope (cross-session)"),
      },
      async execute(args, ctx) {
        const directory = ctx.directory || process.cwd()
        const currentSID = ctx.sessionID
        switch (args.action) {
          case "list": {
            const tasks = args.all ? store.list() : store.listBySession(currentSID)
            return JSON.stringify(
              {
                ok: true,
                scope: args.all ? "all" : currentSID,
                count: tasks.length,
                tasks: tasks.map((t) => ({
                  id: t.id,
                  mode: t.mode,
                  sessionID: t.sessionID,
                  prompt: t.prompt.slice(0, 200) + (t.prompt.length > 200 ? "..." : ""),
                  intervalMs: t.intervalMs,
                  adaptiveMinMs: t.adaptiveMinMs,
                  adaptiveMaxMs: t.adaptiveMaxMs,
                  paused: t.paused,
                  createdAt: new Date(t.createdAt).toISOString(),
                  lastFiredAt: t.lastFiredAt ? new Date(t.lastFiredAt).toISOString() : null,
                  nextDueAt: new Date(t.nextDueAt).toISOString(),
                })),
              },
              null,
              2
            )
          }

          case "cancel": {
            if (!args.taskId)
              return JSON.stringify({ ok: false, error: "taskId required" })
            const t = store.get(args.taskId)
            if (!t) return JSON.stringify({ ok: false, error: `No task ${args.taskId}` })
            if (!args.all && t.sessionID !== currentSID) {
              return JSON.stringify({
                ok: false,
                error: `Task belongs to another session (${t.sessionID}). Pass all=true to override.`,
              })
            }
            const removed = await store.cancel(args.taskId)
            return JSON.stringify(
              {
                ok: !!removed,
                removed,
                message: removed ? `Cancelled ${args.taskId}` : `No task ${args.taskId}`,
              },
              null,
              2
            )
          }

          case "pause": {
            if (!args.taskId)
              return JSON.stringify({ ok: false, error: "taskId required" })
            const t = store.get(args.taskId)
            if (!t) return JSON.stringify({ ok: false, error: `No task ${args.taskId}` })
            if (!args.all && t.sessionID !== currentSID) {
              return JSON.stringify({
                ok: false,
                error: `Task belongs to another session. Pass all=true to override.`,
              })
            }
            const r = await store.setPaused(args.taskId, true)
            return JSON.stringify({ ok: !!r, task: r }, null, 2)
          }

          case "resume": {
            if (!args.taskId)
              return JSON.stringify({ ok: false, error: "taskId required" })
            const t = store.get(args.taskId)
            if (!t) return JSON.stringify({ ok: false, error: `No task ${args.taskId}` })
            if (!args.all && t.sessionID !== currentSID) {
              return JSON.stringify({
                ok: false,
                error: `Task belongs to another session. Pass all=true to override.`,
              })
            }
            const r = await store.setPaused(args.taskId, false)
            if (r) {
              // Re-arm per mode (B6), same as /loop resume.
              if (r.mode === "fixed" && r.intervalMs) {
                await scheduler.rearmFixed(r)
              } else if (r.mode === "adaptive") {
                await scheduler.rearmAdaptive(r)
              } else if (r.mode === "maintenance" && r.adaptiveMaxMs) {
                await store.reschedule(r.id, Date.now() + r.adaptiveMaxMs)
              }
            }
            return JSON.stringify({ ok: !!r, task: r }, null, 2)
          }

          case "create": {
            if (!args.prompt)
              return JSON.stringify({ ok: false, error: "prompt required" })
            const sid = currentSID
            if (!sid)
              return JSON.stringify({ ok: false, error: "No sessionID in context" })
            const mode = args.mode ?? (args.intervalMs ? "fixed" : "adaptive")
            if (args.once && mode !== "fixed") {
              return JSON.stringify({ ok: false, error: "once is supported only for fixed tasks" })
            }
            const input: any = {
              prompt: args.prompt,
              mode,
              once: args.once || undefined,
              directory,
              source: "user",
              sessionID: sid,
            }
            if (mode === "fixed" && args.intervalMs) {
              input.intervalMs = args.intervalMs
              input.jitterEnabled =
                args.jitterEnabled ?? scheduler.opts.defaultJitterEnabled ?? true
            }
            if (mode === "adaptive") {
              // B5: honor the configured adaptive bounds instead of hardcoding.
              input.adaptiveMinMs = scheduler.opts.adaptiveMinMs
              input.adaptiveMaxMs = scheduler.opts.adaptiveMaxMs
            }
            const task = await store.create(input)
            if (task.mode === "adaptive") await scheduler.rearmAdaptive(task)
            return JSON.stringify(
              {
                ok: true,
                task: {
                  id: task.id,
                  mode: task.mode,
                  sessionID: task.sessionID,
                  intervalMs: task.intervalMs,
                  nextDueAt: new Date(task.nextDueAt).toISOString(),
                },
                message: `Loop task created [id=${task.id}] [s=${sid.slice(0, 8)}]. Call loop_schedule(action='cancel', taskId='${task.id}') when done.`,
              },
              null,
              2
            )
          }

          case "reschedule": {
            if (args.delayMs !== undefined && args.nextDueAtMs !== undefined) {
              return JSON.stringify({
                ok: false,
                error: "delayMs and nextDueAtMs are mutually exclusive",
              })
            }
            if (!args.taskId)
              return JSON.stringify({ ok: false, error: "taskId required" })
            const t = store.get(args.taskId)
            if (!t) return JSON.stringify({ ok: false, error: `No task ${args.taskId}` })
            if (!args.all && t.sessionID !== currentSID) {
              return JSON.stringify({
                ok: false,
                error: `Task belongs to another session. Pass all=true to override.`,
              })
            }
            if (args.delayMs !== undefined && t.mode !== "adaptive") {
              return JSON.stringify({
                ok: false,
                error: "delayMs is supported only for Adaptive tasks",
              })
            }
            const toolCallTime = Date.now()
            const requestedNextDueAt = args.nextDueAtMs
            const next =
              t.mode === "adaptive"
                ? args.delayMs !== undefined
                  ? scheduler.clampAdaptiveNextDueAt(
                      t,
                      toolCallTime + args.delayMs,
                      toolCallTime
                    )
                  : requestedNextDueAt === undefined
                    ? scheduler.adaptiveNextDueAt(t, toolCallTime)
                    : scheduler.clampAdaptiveNextDueAt(t, requestedNextDueAt, toolCallTime)
                : requestedNextDueAt ?? toolCallTime + scheduler.clampAdaptive(5 * 60_000)
            const r = await store.reschedule(args.taskId, next)
            return JSON.stringify(
              {
                ok: !!r,
                requestedDelayMs: args.delayMs,
                effectiveDelayMs: args.delayMs === undefined ? undefined : next - toolCallTime,
                requestedNextDueAt:
                  requestedNextDueAt === undefined
                    ? undefined
                    : new Date(requestedNextDueAt).toISOString(),
                task: r ? { id: r.id, nextDueAt: new Date(r.nextDueAt).toISOString() } : null,
              },
              null,
              2
            )
          }

          case "set_fixed": {
            if (!args.taskId)
              return JSON.stringify({ ok: false, error: "taskId required" })
            if (!Number.isFinite(args.intervalMs) || (args.intervalMs ?? 0) < 1_000) {
              return JSON.stringify({
                ok: false,
                error: "intervalMs must be a finite number of at least 1000ms",
              })
            }
            const t = store.get(args.taskId)
            if (!t) return JSON.stringify({ ok: false, error: `No task ${args.taskId}` })
            if (!args.all && t.sessionID !== currentSID) {
              return JSON.stringify({
                ok: false,
                error: `Task belongs to another session. Pass all=true to override.`,
              })
            }
            if (t.mode !== "adaptive") {
              return JSON.stringify({
                ok: false,
                error: "set_fixed requires an Adaptive task",
              })
            }
            // B7: apply the configured jitter policy to the FIRST cycle too,
            // so conversion and later re-arms behave identically.
            const conversionTime = Date.now()
            const r = await store.setFixed(
              args.taskId,
              args.intervalMs as number,
              args.jitterEnabled ?? false,
              conversionTime
            )
            if (r) await scheduler.rearmFixed(r, conversionTime)
            return JSON.stringify(
              {
                ok: !!r,
                task: r
                  ? {
                      id: r.id,
                      mode: r.mode,
                      intervalMs: r.intervalMs,
                      jitterEnabled: r.jitterEnabled,
                      lastFiredAt: r.lastFiredAt,
                      nextDueAt: new Date(r.nextDueAt).toISOString(),
                    }
                  : null,
              },
              null,
              2
            )
          }

          default:
            return JSON.stringify({ ok: false, error: `Unknown action: ${args.action}` })
        }
      },
    }),

    loop_status: tool({
      description:
        "Show /loop task status. Defaults to current session; pass all=true to see all sessions.",
      args: {
        all: z.boolean().optional().describe("Show tasks from all sessions"),
      },
      async execute(args, ctx) {
        const tasks = args.all ? store.list() : store.listBySession(ctx.sessionID)
        const summary = {
          ok: true,
          scope: args.all ? "all" : ctx.sessionID,
          activeTasks: tasks.filter((t) => !t.paused).length,
          pausedTasks: tasks.filter((t) => t.paused).length,
          tasks: tasks.map((t) => ({
            id: t.id,
            mode: t.mode,
            sessionID: t.sessionID,
            prompt: t.prompt.slice(0, 80) + (t.prompt.length > 80 ? "..." : ""),
            intervalMs: t.intervalMs,
            nextDueAt: new Date(t.nextDueAt).toISOString(),
            paused: t.paused,
            lastFiredAt: t.lastFiredAt ? new Date(t.lastFiredAt).toISOString() : null,
          })),
        }
        return JSON.stringify(summary, null, 2)
      },
    }),
  }
}
