import type { PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import type { CommandParseResult } from "./scheduler.js"

const SERVICE = "opencode-plugin-loop"
const HANDLED_COMMAND_PROMPT =
  "The /loop command was already handled by the opencode-plugin-loop plugin, and its result was displayed in the OpenCode TUI. Reply with a brief acknowledgement only. Do not call tools or perform the command arguments as a separate task."

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

export function consumeLoopCommand(parts: Part[]): void {
  let replaced = false
  for (const part of parts) {
    if (part.type !== "text") continue
    if (!replaced) {
      part.text = HANDLED_COMMAND_PROMPT
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

export async function showLoopResult(
  client: PluginInput["client"],
  result: CommandParseResult,
  logger: LoopLogger
): Promise<void> {
  try {
    await client.tui.showToast({
      body: {
        title: "Loop",
        message: result.message,
        variant: toastVariant(result.message),
        duration: toastDuration(result.message),
      },
    })
  } catch (error) {
    await logger("warn", "failed to show loop command result", {
      error: errorMessage(error),
    })
  }
}
