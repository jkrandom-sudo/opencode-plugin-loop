export const LOOP_FEEDBACK_TITLE = "Loop · opencode-plugin-loop"
export const LOOP_COPY_TITLE = "Loop copy"

export type LoopFeedbackVariant = "info" | "success" | "warning" | "error"

export interface LoopFeedbackInput {
  message: string
  variant: LoopFeedbackVariant
}

export interface LoopTaskInfo {
  readonly id: string
  readonly status: "active" | "paused"
  readonly interval: string
  readonly prompt: string
  readonly once: boolean
  readonly session?: string
}

export interface LoopFeedbackModel {
  readonly message: string
  readonly variant: LoopFeedbackVariant
  readonly taskIds: readonly string[]
  readonly tasks: readonly LoopTaskInfo[]
}

interface IndexedTaskId {
  index: number
  id: string
}

const TASK_ID = "[A-Za-z0-9_-]+"
const TASK_ID_PATTERNS = [
  new RegExp(`\\[id=(${TASK_ID})\\]`, "g"),
  new RegExp(`^\\s*\\[(${TASK_ID})\\]`, "gm"),
]

const TASK_LINE = /^\s*\[([A-Za-z0-9_-]+)\](?:\s+\[s:([^\]]+)\])?\s+(▶ active|⏸ paused)\s+•\s+(.+?)\s+•\s+(.*)$/
const ONCE_PREFIX = "once • "

export function parseLoopTaskList(message: string): LoopTaskInfo[] {
  const tasks: LoopTaskInfo[] = []
  for (const line of message.split("\n")) {
    const match = TASK_LINE.exec(line)
    if (!match) continue
    const [, id, session, status, interval, rest] = match
    if (!id || !status || !interval) continue
    const once = rest.startsWith(ONCE_PREFIX)
    tasks.push({
      id,
      status: status.startsWith("⏸") ? "paused" : "active",
      interval,
      prompt: once ? rest.slice(ONCE_PREFIX.length) : rest,
      once,
      ...(session ? { session } : {}),
    })
  }
  return tasks
}

export function extractTaskIds(message: string): string[] {
  const matches: IndexedTaskId[] = []

  for (const pattern of TASK_ID_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(message)) !== null) {
      if (!match[1]) continue
      matches.push({ index: match.index, id: match[1] })
    }
  }

  matches.sort((left, right) => left.index - right.index)

  const seen = new Set<string>()
  return matches.flatMap(({ id }) => {
    if (seen.has(id)) return []
    seen.add(id)
    return [id]
  })
}

export function createLoopFeedbackModel(input: LoopFeedbackInput): LoopFeedbackModel {
  const taskIds = Object.freeze(extractTaskIds(input.message))
  const tasks = Object.freeze(
    input.variant === "info" ? parseLoopTaskList(input.message) : []
  )
  return Object.freeze({
    message: input.message,
    variant: input.variant,
    taskIds,
    tasks,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isVariant(value: unknown): value is LoopFeedbackVariant {
  return value === "info" || value === "success" || value === "warning" || value === "error"
}

export function isLoopFeedbackToast(event: unknown): event is {
  type: "tui.toast.show"
  properties: LoopFeedbackInput & Record<string, unknown>
} {
  if (!isRecord(event) || event.type !== "tui.toast.show") return false
  if (!isRecord(event.properties)) return false

  return (
    event.properties.title === LOOP_FEEDBACK_TITLE &&
    typeof event.properties.message === "string" &&
    isVariant(event.properties.variant)
  )
}

export function isLoopTaskListToast(event: unknown): event is {
  type: "tui.toast.show"
  properties: LoopFeedbackInput & Record<string, unknown>
} {
  return isLoopFeedbackToast(event) && event.properties.variant === "info"
}
