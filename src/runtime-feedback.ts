import type { PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { createHash } from "node:crypto"

const SERVICE = "opencode-plugin-loop"
const HANDLED_COMMAND_PROMPT =
  "The /loop command was already handled by the opencode-plugin-loop plugin, and its result was displayed in the OpenCode TUI. Reply with a brief acknowledgement only. Do not call tools or perform the command arguments as a separate task."

export function buildLoopCreatedPrompt(input: {
  prompt: string
  schedule: string
  taskId: string
  once?: boolean
}): string {
  return [
    "The opencode-plugin-loop plugin has successfully created a scheduled loop task from the user's /loop command:",
    `- Task: "${input.prompt}"`,
    `- Schedule: ${input.schedule}${input.once ? " (runs once)" : ""}`,
    `- Job ID: ${input.taskId}`,
    `- Cancel anytime with: /loop cancel ${input.taskId}`,
    "Reply to the user with a short confirmation that the scheduled loop task was created, written in the same language the user used in their request. Include the task, schedule, and job ID from above. This reply is only the creation confirmation — the plugin executes the task automatically at each scheduled time, so do not execute the task and do not call tools in this reply.",
  ].join("\n")
}

export function buildLoopFailedPrompt(message: string): string {
  const reason = message.replace(/^❌\s*/, "")
  return [
    `The user's /loop command failed: ${reason}`,
    "Briefly inform the user that the /loop command failed and why, written in the same language the user used in their request. Do not call tools in this reply and do not attempt to perform the command arguments as a separate task.",
  ].join("\n")
}

export function buildLoopResultPrompt(message: string): string {
  const body = message.replace(/^📋\s*/, "").replace(/^📭\s*/, "")
  return [
    "The opencode-plugin-loop plugin has fully handled the user's /loop command. The command result is:",
    "",
    body,
    "",
    "Present this result to the user, written in the same language the user used in their request:",
    "- If it is a task list, render it as a markdown table with columns: Job ID, frequency, content, and type (every task is a session-scoped loop that auto-expires after 7 days idle). Keep the management commands (`/loop cancel|pause|resume <id>`, `/loop stop-all`) mentioned below the table.",
    "- If it confirms an action (cancel, pause, resume, stop-all), confirm concisely which task was affected and whether it will trigger again.",
    "- If it is help text or an empty state, present it naturally.",
    "Do not call tools in this reply, and do not execute any task prompt in this reply — scheduled tasks run automatically when they are due.",
  ].join("\n")
}

export function buildFixedExecutionPrompt(task: {
  id: string
  prompt: string
}): string {
  return [
    `This is the scheduled execution of /loop task ${task.id}. Perform the task described below now, then report the result concisely.`,
    "",
    task.prompt,
  ].join("\n")
}

/**
 * First execution of a freshly created fixed task: the task runs immediately
 * in the current turn (Claude Code behavior), then repeats on schedule.
 */
export function buildFixedFirstRunPrompt(input: {
  prompt: string
  schedule: string
  taskId: string
}): string {
  return [
    `The /loop task ${input.taskId} has just been scheduled to run ${input.schedule}. This is its first execution — it runs now, then repeats on schedule (cancel anytime with: /loop cancel ${input.taskId}).`,
    "Briefly confirm the schedule in the user's language, then perform the task described below now and report the result concisely.",
    "",
    input.prompt,
  ].join("\n")
}

/** Stable short content hash for loop.md change detection. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16)
}

/**
 * Maintenance execution for file-backed tasks (loop.md is re-read on every
 * fire, Claude Code style): fresh/changed content is injected in full;
 * unchanged content gets a short cache-friendly reminder.
 */
export function buildMaintenanceExecutionPrompt(
  task: { id: string },
  freshContent: string | null
): string {
  if (freshContent === null) {
    return [
      `This is the scheduled execution of /loop maintenance task ${task.id}. The maintenance instructions from loop.md are unchanged since the previous run earlier in this conversation — refer to them above.`,
      "If there is pending maintenance work, perform it now and report concisely. If nothing is pending, reply with one line saying so and call loop_schedule(action=\"cancel\", taskId=\"" + task.id + "\") to end the loop.",
    ].join("\n")
  }
  return [
    `This is the scheduled execution of /loop maintenance task ${task.id}. The maintenance instructions from loop.md (re-read at fire time; they may have been edited since the last run) follow below — perform them now, then report concisely.`,
    `When the work is complete and no further checks are needed, call loop_schedule(action="cancel", taskId="${task.id}") to end the loop.`,
    "",
    freshContent,
  ].join("\n")
}

export type LoopLogLevel = "debug" | "info" | "warn" | "error"
export type LoopLogger = (
  level: LoopLogLevel,
  message: string,
  extra?: Record<string, unknown>
) => Promise<void>

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createLoopLogger(client: PluginInput["client"]): LoopLogger {
  return async (level, message, extra) => {
    try {
      if (!client.app?.log) return
      await client.app.log({
        throwOnError: true,
        body: {
          service: SERVICE,
          level,
          message,
          extra,
        },
      })
    } catch {
      // Structured logging must never interrupt loop scheduling or TUI updates.
    }
  }
}

export function consumeLoopCommand(
  parts: Part[],
  replacement: string = HANDLED_COMMAND_PROMPT
): void {
  let replaced = false
  for (const part of parts) {
    if (part.type !== "text") continue
    if (!replaced) {
      part.text = replacement
      part.synthetic = true
      replaced = true
      continue
    }
    part.ignored = true
  }
}
