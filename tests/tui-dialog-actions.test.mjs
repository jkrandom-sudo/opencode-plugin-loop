import assert from "node:assert/strict"
import test from "node:test"

import {
  createLoopActionRunner,
  createLoopDialogActions,
} from "../dist/tui-dialog-actions.js"

test("orders task copies before Copy all and Close", () => {
  assert.deepEqual(createLoopDialogActions(["abc123", "def456"]), [
    { type: "copy-id", taskId: "abc123" },
    { type: "copy-id", taskId: "def456" },
    { type: "copy-all" },
    { type: "close" },
  ])
})

test("successful copies close only their current generation", async () => {
  const copied = []
  let current = true
  let closes = 0
  const runner = createLoopActionRunner({
    writeClipboard: async (text) => copied.push(text),
    notifySuccess() {},
    notifyFailure() {},
    closeIfCurrent: () => {
      if (current) closes++
    },
  })

  await runner.run({ type: "copy-id", taskId: "abc123" }, "full message")
  assert.deepEqual(copied, ["abc123"])
  assert.equal(closes, 1)

  current = false
  await runner.run({ type: "copy-all" }, "full message")
  assert.deepEqual(copied, ["abc123", "full message"])
  assert.equal(closes, 1)
})

test("clipboard failure keeps the dialog open", async () => {
  let failures = 0
  let closes = 0
  const runner = createLoopActionRunner({
    writeClipboard: async () => {
      throw new Error("denied")
    },
    notifySuccess() {},
    notifyFailure: () => failures++,
    closeIfCurrent: () => closes++,
  })

  await runner.run({ type: "copy-all" }, "exact")
  assert.equal(failures, 1)
  assert.equal(closes, 0)
  assert.equal(runner.busy, false)
})

test("duplicate activation is ignored while copying", async () => {
  let release
  let writes = 0
  const runner = createLoopActionRunner({
    writeClipboard: () =>
      new Promise((resolve) => {
        writes++
        release = resolve
      }),
    notifySuccess() {},
    notifyFailure() {},
    closeIfCurrent() {},
  })

  const first = runner.run({ type: "copy-all" }, "exact")
  const second = runner.run({ type: "copy-all" }, "exact")
  assert.equal(writes, 1)
  assert.equal(runner.busy, true)
  release()
  await Promise.all([first, second])
  assert.equal(runner.busy, false)
})

test("Close bypasses clipboard and closes immediately", async () => {
  let writes = 0
  let closes = 0
  const runner = createLoopActionRunner({
    writeClipboard: async () => writes++,
    notifySuccess() {},
    notifyFailure() {},
    closeIfCurrent: () => closes++,
  })

  await runner.run({ type: "close" }, "message")
  assert.equal(writes, 0)
  assert.equal(closes, 1)
})
