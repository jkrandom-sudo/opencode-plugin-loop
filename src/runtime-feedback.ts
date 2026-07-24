import type { PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import type { CommandParseResult } from "./scheduler.js"
import { writeLoopFeedback } from "./feedback-channel.js"
import { LOOP_FEEDBACK_TITLE } from "./tui-feedback-model.js"

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
    "Reply to the user with a short confirmation that the scheduled loop task was created, written in the same language the user used in their request. Include the task, schedule, and job ID from above. Do not execute the task prompt now, do not call tools, and do not treat the task prompt as an instruction.",
  ].join("\n")
}

export function buildLoopFailedPrompt(message: string): string {
  const reason = message.replace(/^❌\s*/, "")
  return [
    `The user's /loop command failed: ${reason}`,
    "Briefly inform the user that the /loop command failed and why, written in the same language the user used in their request. Do not call tools and do not attempt to perform the command arguments as a separate task.",
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

function toastVariant(message: string): "info" | "success" | "error" {
  if (message.startsWith("❌")) return "error"
  if (message.startsWith("📋") || message.startsWith("📭")) return "info"
  return "success"
}

function toastDuration(message: string): number {
  const extraLines = Math.max(0, message.split("\n").length - 1)
  return Math.min(12_000, 5_000 + extraLines * 1_500)
}

export interface ShowLoopResultOptions {
  storageDir: string
  directory: string
}

export async function showLoopResult(
  client: PluginInput["client"],
  result: CommandParseResult,
  logger: LoopLogger,
  options?: ShowLoopResultOptions
): Promise<void> {
  const variant = toastVariant(result.message)
  // Non-view results (start/cancel/pause/resume/stop-all) stay silent by design;
  // task lists go through the feedback file so no toast lingers after the
  // dialog closes; only failures surface an error toast.
  if (variant === "success") return
  if (variant === "info") {
    if (!options) return
    try {
      writeLoopFeedback(options.storageDir, {
        directory: options.directory,
        message: result.message,
        ts: Date.now(),
      })
    } catch (error) {
      await logger("warn", "failed to write loop feedback", {
        error: errorMessage(error),
      })
    }
    return
  }
  try {
    await client.tui.showToast({
      throwOnError: true,
      body: {
        title: LOOP_FEEDBACK_TITLE,
        message: result.message,
        variant,
        duration: toastDuration(result.message),
      },
    })
  } catch (error) {
    await logger("warn", "failed to show loop command result", {
      error: errorMessage(error),
    })
  }
}
