import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

export interface LoopFeedbackPayload {
  directory: string
  message: string
  ts: number
}

export const LOOP_FEEDBACK_FILE = "tui-feedback.json"

export function loopFeedbackPath(storageDir: string): string {
  return join(storageDir, LOOP_FEEDBACK_FILE)
}

export function writeLoopFeedback(
  storageDir: string,
  payload: LoopFeedbackPayload
): void {
  mkdirSync(storageDir, { recursive: true })
  const target = loopFeedbackPath(storageDir)
  const tmp = join(storageDir, `.${LOOP_FEEDBACK_FILE}.${randomUUID()}.tmp`)
  writeFileSync(tmp, JSON.stringify(payload), "utf8")
  renameSync(tmp, target)
}

export function readLoopFeedback(path: string): LoopFeedbackPayload | undefined {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== "object" || value === null) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.directory !== "string") return undefined
    if (typeof record.message !== "string") return undefined
    if (typeof record.ts !== "number") return undefined
    return { directory: record.directory, message: record.message, ts: record.ts }
  } catch {
    return undefined
  }
}
