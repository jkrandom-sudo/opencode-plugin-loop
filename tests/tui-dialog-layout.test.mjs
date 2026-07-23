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
    listRows: 3,
  })
  assert.deepEqual(allocateLoopDialogRows(80, 52), {
    maxHeight: 28,
    messageRows: 19,
    listRows: 6,
  })
})

test("never allocates beyond an extremely short terminal", () => {
  assert.deepEqual(allocateLoopDialogRows(7, 3), {
    maxHeight: 3,
    messageRows: 0,
    listRows: 0,
  })
})

test("task list mode reserves rows for the hint bar and caps the list", () => {
  assert.deepEqual(allocateLoopDialogRows(24, 6, true), {
    maxHeight: 16,
    messageRows: 0,
    listRows: 6,
  })
  assert.deepEqual(allocateLoopDialogRows(24, 30, true), {
    maxHeight: 16,
    messageRows: 0,
    listRows: 11,
  })
  assert.deepEqual(allocateLoopDialogRows(6, 4, true), {
    maxHeight: 2,
    messageRows: 0,
    listRows: 1,
  })
})

test("action selection wraps in both directions", () => {
  assert.equal(moveLoopActionIndex(0, -1, 3), 2)
  assert.equal(moveLoopActionIndex(2, 1, 3), 0)
  assert.equal(moveLoopActionIndex(4, 2, 0), 0)
})
