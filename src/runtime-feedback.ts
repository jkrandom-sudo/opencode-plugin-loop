import type { PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"

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
