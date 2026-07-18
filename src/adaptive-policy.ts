import type { LoopTask } from "./types.js"

export interface AdaptiveDefaults {
  minMs: number
  maxMs: number
}

function validBound(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) < 0) return Math.max(0, Math.floor(fallback))
  return Math.floor(value as number)
}

export function adaptiveBounds(
  task: Pick<LoopTask, "adaptiveMinMs" | "adaptiveMaxMs">,
  defaults: AdaptiveDefaults
): AdaptiveDefaults {
  const first = validBound(task.adaptiveMinMs, defaults.minMs)
  const second = validBound(task.adaptiveMaxMs, defaults.maxMs)
  return {
    minMs: Math.min(first, second),
    maxMs: Math.max(first, second),
  }
}

function randomUnit(random: () => number): number {
  const value = random()
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1 - Number.EPSILON, value))
}

export function randomAdaptiveNextDueAt(
  task: Pick<LoopTask, "adaptiveMinMs" | "adaptiveMaxMs">,
  defaults: AdaptiveDefaults,
  random: () => number = Math.random,
  now: number = Date.now()
): number {
  const { minMs, maxMs } = adaptiveBounds(task, defaults)
  const delay = minMs + Math.floor(randomUnit(random) * (maxMs - minMs + 1))
  return now + delay
}

export function clampAdaptiveNextDueAt(
  task: Pick<LoopTask, "adaptiveMinMs" | "adaptiveMaxMs">,
  defaults: AdaptiveDefaults,
  requestedAt: number,
  now: number = Date.now()
): number {
  const { minMs, maxMs } = adaptiveBounds(task, defaults)
  const requestedDelay = Number.isFinite(requestedAt) ? requestedAt - now : minMs
  return now + Math.max(minMs, Math.min(maxMs, requestedDelay))
}

export function buildAdaptiveExecutionPrompt(
  task: Pick<
    LoopTask,
    "id" | "prompt" | "adaptiveMinMs" | "adaptiveMaxMs" | "nextDueAt"
  >,
  defaults: AdaptiveDefaults
): string {
  const { minMs, maxMs } = adaptiveBounds(task, defaults)
  const fallbackIso = new Date(task.nextDueAt).toISOString()

  return `${task.prompt}

<adaptive_loop_schedule>
This is Adaptive loop task ${task.id}. Complete the user request above first. After observing the current session state and this execution's result, decide whether the next run needs a different time.

A fallback run is already scheduled at ${task.nextDueAt} (${fallbackIso}), using the allowed delay range ${minMs}ms to ${maxMs}ms. Keep that fallback by making no scheduling tool call when it is appropriate.

If the user's request contains a clear, stable recurring cadence (for example, "every two minutes"), convert this Adaptive task to a permanent Fixed task after completing the request. Call loop_schedule exactly once with action="set_fixed", taskId="${task.id}", and intervalMs set to that relative period in milliseconds. Fixed conversion defaults to jitter disabled, so repeated runs use the exact requested interval.

If the next time should instead depend on this execution's result, call loop_schedule exactly once with action="reschedule", taskId="${task.id}", and delayMs set to a relative delay from now within ${minMs}ms to ${maxMs}ms. An accepted in-range delay is stored without jitter; only an out-of-range delay is clamped to the nearest bound. Prefer a shorter delay for pending, rapidly changing, or retryable conditions and a longer delay for stable or slow-moving conditions. Do not calculate an epoch timestamp when delayMs can express the decision.

If the task is fully complete and no future check is useful, call loop_schedule with action="cancel" and taskId="${task.id}". Do not claim that the schedule changed unless the tool call succeeds.
</adaptive_loop_schedule>`
}
