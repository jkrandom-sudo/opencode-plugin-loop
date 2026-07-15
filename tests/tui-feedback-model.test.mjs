import assert from "node:assert/strict"
import test from "node:test"

import {
  LOOP_COPY_TITLE,
  LOOP_FEEDBACK_TITLE,
  createLoopFeedbackModel,
  extractTaskIds,
  isLoopFeedbackToast,
} from "../dist/tui-feedback-model.js"

test("extracts a task id from loop creation feedback", () => {
  assert.deepEqual(extractTaskIds("Loop started [id=abc123]"), ["abc123"])
})

test("extracts task ids from list rows in display order", () => {
  const message = "[first01] active\n[second2] paused"
  assert.deepEqual(extractTaskIds(message), ["first01", "second2"])
})

test("preserves source order across list rows and inline ids", () => {
  const message = "[first01] active\nCreated [id=second2]"
  assert.deepEqual(extractTaskIds(message), ["first01", "second2"])
})

test("deduplicates task ids while preserving the first occurrence", () => {
  const message = "Created [id=repeat1]\n[repeat1] active\n[other2] active"
  assert.deepEqual(extractTaskIds(message), ["repeat1", "other2"])
})

test("rejects malformed task ids", () => {
  assert.deepEqual(extractTaskIds("Created [id=bad id] and [not an id]"), [])
})

test("creates an immutable feedback model with the exact message", () => {
  const input = {
    message: "[first01] active\n[second2] paused",
    variant: "info",
  }
  const model = createLoopFeedbackModel(input)

  assert.deepEqual(model, {
    message: input.message,
    variant: "info",
    taskIds: ["first01", "second2"],
  })
  assert.ok(Object.isFrozen(model))
  assert.ok(Object.isFrozen(model.taskIds))
})

test("recognizes only plugin-owned Loop feedback toast events", () => {
  const event = {
    type: "tui.toast.show",
    properties: {
      title: LOOP_FEEDBACK_TITLE,
      message: "Loop started [id=abc123]",
      variant: "success",
      duration: 5000,
    },
  }

  assert.equal(isLoopFeedbackToast(event), true)
  assert.equal(
    isLoopFeedbackToast({
      ...event,
      properties: { ...event.properties, title: LOOP_COPY_TITLE },
    }),
    false,
  )
  assert.equal(
    isLoopFeedbackToast({
      ...event,
      properties: { ...event.properties, variant: "unknown" },
    }),
    false,
  )
  assert.equal(isLoopFeedbackToast({ type: "other", properties: event.properties }), false)
  assert.equal(isLoopFeedbackToast(null), false)
})
