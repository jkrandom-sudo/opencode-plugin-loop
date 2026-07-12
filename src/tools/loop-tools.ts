/**
 * LLM-callable tools for the loop plugin.
 *
 * Two tools:
 *   - loop_schedule: create/list/cancel/reschedule/pause/resume
 *   - loop_status:   show running tasks + recent fire history
 *
 * Per-session scoping:
 *   - create binds task to ctx.sessionID (ToolContext)
 *   - list/status default to current session, with `all: true` to see all
 *   - cancel/pause/resume/reschedule are session-scoped unless `all: true`
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
        "Manage /loop tasks: create, list, cancel, pause, resume, or reschedule. Each task is bound to the session that created it; pass all=true to cross session boundaries.",
      args: {
        action: z.enum(["create", "list", "cancel", "reschedule", "pause", "resume"]),
        taskId: z.string().optional().describe("Required for cancel/reschedule/pause/resume"),
        prompt: z.string().optional().describe("Required for create; the prompt to re-inject each cycle"),
        intervalMs: z.number().optional().describe("Fixed interval in milliseconds (for create+fixed mode)"),
        nextDueAtMs: z.number().optional().describe("Epoch ms when this task should next fire (for reschedule)"),
        mode: z
          .enum(["fixed", "adaptive", "maintenance"])
          .optional()
          .describe("Default: fixed if intervalMs set, else adaptive"),
        all: z
          .boolean()
          .optional()
          .describe("For list/cancel/pause/resume: ignore session scope (cross-session)"),
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
            if (r && r.mode === "fixed" && r.intervalMs) {
              await scheduler.rearmFixed(r)
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
            const input: any = {
              prompt: args.prompt,
              mode,
              directory,
              source: "user",
              sessionID: sid,
            }
            if (mode === "fixed" && args.intervalMs) input.intervalMs = args.intervalMs
            if (mode === "adaptive") {
              input.adaptiveMinMs = 60_000
              input.adaptiveMaxMs = 3_600_000
            }
            const task = await store.create(input)
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
            const next = args.nextDueAtMs ?? Date.now() + scheduler.clampAdaptive(5 * 60_000)
            const r = await store.reschedule(args.taskId, next)
            return JSON.stringify(
              {
                ok: !!r,
                task: r ? { id: r.id, nextDueAt: new Date(r.nextDueAt).toISOString() } : null,
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