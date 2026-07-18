import assert from "node:assert/strict"
import test from "node:test"

import {
  adaptiveBounds,
  buildAdaptiveExecutionPrompt,
  clampAdaptiveNextDueAt,
  randomAdaptiveNextDueAt,
} from "../dist/adaptive-policy.js"

const defaults = { minMs: 60_000, maxMs: 3_600_000 }

function task(overrides = {}) {
  return {
    id: "adaptive1",
    prompt: "Check the deployment and report the current result.",
    mode: "adaptive",
    adaptiveMinMs: 1_000,
    adaptiveMaxMs: 3_000,
    createdAt: 1,
    lastFiredAt: 0,
    nextDueAt: 12_000,
    source: "user",
    directory: "/tmp/project",
    sessionID: "session-a",
    paused: false,
    ...overrides,
  }
}

test("normalizes task-specific adaptive bounds", () => {
  assert.deepEqual(adaptiveBounds(task(), defaults), { minMs: 1_000, maxMs: 3_000 })
  assert.deepEqual(
    adaptiveBounds(task({ adaptiveMinMs: 4_000, adaptiveMaxMs: 1_000 }), defaults),
    { minMs: 1_000, maxMs: 4_000 }
  )
  assert.deepEqual(
    adaptiveBounds(task({ adaptiveMinMs: Number.NaN, adaptiveMaxMs: undefined }), defaults),
    defaults
  )
})

test("selects minimum, midpoint, and maximum-edge random fallback times", () => {
  const now = 10_000
  assert.equal(randomAdaptiveNextDueAt(task(), defaults, () => 0, now), 11_000)
  assert.equal(randomAdaptiveNextDueAt(task(), defaults, () => 0.5, now), 12_000)
  assert.equal(randomAdaptiveNextDueAt(task(), defaults, () => 0.999999, now), 13_000)
})

test("clamps requested absolute times to adaptive bounds", () => {
  const now = 10_000
  assert.equal(clampAdaptiveNextDueAt(task(), defaults, 10_500, now), 11_000)
  assert.equal(clampAdaptiveNextDueAt(task(), defaults, 12_000, now), 12_000)
  assert.equal(clampAdaptiveNextDueAt(task(), defaults, 15_000, now), 13_000)
})

test("builds an execution prompt that preserves the request and explains scheduling", () => {
  const value = buildAdaptiveExecutionPrompt(task(), defaults)

  assert.match(value, /Check the deployment and report the current result\./)
  assert.match(value, /adaptive1/)
  assert.match(value, /1000/)
  assert.match(value, /3000/)
  assert.match(value, /12000/)
  assert.match(value, new RegExp(new Date(12_000).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(value, /loop_schedule/)
  assert.match(value, /reschedule/)
  assert.match(value, /cancel/)
  assert.match(value, /fallback/i)
  assert.match(value, /after.*result/i)
  assert.match(value, /without jitter/i)
})
