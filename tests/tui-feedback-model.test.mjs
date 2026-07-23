import assert from "node:assert/strict"
import test from "node:test"

import {
  LOOP_COPY_TITLE,
  LOOP_FEEDBACK_TITLE,
  createLoopFeedbackModel,
  extractTaskIds,
  isLoopFeedbackToast,
  isLoopTaskListToast,
  parseLoopTaskList,
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

test("parses task rows with status, interval, and prompt", () => {
  const message = [
    "📋 2 loop task(s):",
    "  [first01] ▶ active • every 60s • check the build",
    "  [second2] ⏸ paused • adaptive 30s–120s • watch deploys",
    "Manage: `/loop cancel|pause|resume <id>`",
  ].join("\n")

  assert.deepEqual(parseLoopTaskList(message), [
    {
      id: "first01",
      status: "active",
      interval: "every 60s",
      prompt: "check the build",
      once: false,
    },
    {
      id: "second2",
      status: "paused",
      interval: "adaptive 30s–120s",
      prompt: "watch deploys",
      once: false,
    },
  ])
})

test("parses once flags and session tags", () => {
  const message =
    "  [abc123] [s:ses_070e] ▶ active • every 60s • once • run one time"

  assert.deepEqual(parseLoopTaskList(message), [
    {
      id: "abc123",
      status: "active",
      interval: "every 60s",
      prompt: "run one time",
      once: true,
      session: "ses_070e",
    },
  ])
})

test("returns no tasks for empty or unparseable messages", () => {
  assert.deepEqual(parseLoopTaskList("📭 No loop tasks."), [])
  assert.deepEqual(parseLoopTaskList("Loop started [id=abc123]"), [])
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
    tasks: [],
  })
  assert.ok(Object.isFrozen(model))
  assert.ok(Object.isFrozen(model.taskIds))
  assert.ok(Object.isFrozen(model.tasks))
})

test("parses tasks into the model only for info feedback", () => {
  const message =
    "📋 1 loop task(s):\n  [first01] ▶ active • every 60s • check the build"

  const info = createLoopFeedbackModel({ message, variant: "info" })
  assert.equal(info.tasks.length, 1)
  assert.equal(info.tasks[0].id, "first01")

  const success = createLoopFeedbackModel({ message, variant: "success" })
  assert.deepEqual(success.tasks, [])
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

test("recognizes only info-variant Loop toasts as task lists", () => {
  const base = {
    type: "tui.toast.show",
    properties: {
      title: LOOP_FEEDBACK_TITLE,
      message: "📋 1 loop task(s):",
      duration: 5000,
    },
  }

  assert.equal(
    isLoopTaskListToast({
      ...base,
      properties: { ...base.properties, variant: "info" },
    }),
    true,
  )
  assert.equal(
    isLoopTaskListToast({
      ...base,
      properties: { ...base.properties, variant: "success" },
    }),
    false,
  )
  assert.equal(
    isLoopTaskListToast({
      ...base,
      properties: { ...base.properties, variant: "error" },
    }),
    false,
  )
  assert.equal(isLoopTaskListToast(null), false)
})
