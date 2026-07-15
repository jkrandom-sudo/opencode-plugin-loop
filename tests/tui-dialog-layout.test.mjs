import assert from "node:assert/strict"
import test from "node:test"

import {
  allocateLoopDialogRows,
  moveLoopActionIndex,
} from "../dist/tui-dialog-layout.js"

test("allocates a capped 70-percent dialog with independent viewports", () => {
  assert.deepEqual(allocateLoopDialogRows(24, 3), {
    maxHeight: 16,
    messageRows: 10,
    actionRows: 3,
  })
  assert.deepEqual(allocateLoopDialogRows(80, 52), {
    maxHeight: 28,
    messageRows: 19,
    actionRows: 6,
  })
})

test("never allocates beyond an extremely short terminal", () => {
  assert.deepEqual(allocateLoopDialogRows(7, 3), {
    maxHeight: 3,
    messageRows: 0,
    actionRows: 0,
  })
})

test("action selection wraps in both directions", () => {
  assert.equal(moveLoopActionIndex(0, -1, 3), 2)
  assert.equal(moveLoopActionIndex(2, 1, 3), 0)
  assert.equal(moveLoopActionIndex(4, 2, 0), 0)
})
