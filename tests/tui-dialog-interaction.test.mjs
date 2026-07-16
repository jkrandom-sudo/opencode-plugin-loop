import assert from "node:assert/strict"
import test from "node:test"

import {
  createLoopDialogPointerHandlers,
  handleLoopDialogKey,
} from "../dist/tui-dialog-interaction.js"

function createController() {
  const calls = []
  return {
    calls,
    controller: {
      move: (delta) => calls.push(["move", delta]),
      select: (index) => calls.push(["select", index]),
      activate: () => calls.push(["activate"]),
      activateAt: (index) => calls.push(["activateAt", index]),
      pageMessage: (delta) => calls.push(["pageMessage", delta]),
      close: () => calls.push(["close"]),
    },
  }
}

function keyEvent(name, options = {}) {
  const consumed = []
  return {
    event: {
      name,
      shift: options.shift ?? false,
      preventDefault: () => consumed.push("preventDefault"),
      stopPropagation: () => consumed.push("stopPropagation"),
    },
    consumed,
  }
}

test("maps navigation keys to Loop dialog movement and consumes them", () => {
  const cases = [
    ["up", {}, ["move", -1]],
    ["down", {}, ["move", 1]],
    ["tab", {}, ["move", 1]],
    ["tab", { shift: true }, ["move", -1]],
  ]

  for (const [name, options, expected] of cases) {
    const { calls, controller } = createController()
    const { event, consumed } = keyEvent(name, options)

    assert.equal(handleLoopDialogKey(event, controller), true)
    assert.deepEqual(calls, [expected])
    assert.deepEqual(consumed, ["preventDefault", "stopPropagation"])
  }
})

test("maps activation, paging, and close keys to the selected dialog action", () => {
  const cases = [
    ["enter", ["activate"]],
    ["return", ["activate"]],
    ["space", ["activate"]],
    ["pageup", ["pageMessage", -1]],
    ["pagedown", ["pageMessage", 1]],
    ["q", ["close"]],
  ]

  for (const [name, expected] of cases) {
    const { calls, controller } = createController()
    const { event, consumed } = keyEvent(name)

    assert.equal(handleLoopDialogKey(event, controller), true)
    assert.deepEqual(calls, [expected])
    assert.deepEqual(consumed, ["preventDefault", "stopPropagation"])
  }
})

test("leaves unrelated keyboard input available to OpenCode", () => {
  const { calls, controller } = createController()
  const { event, consumed } = keyEvent("a")

  assert.equal(handleLoopDialogKey(event, controller), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(consumed, [])
})

test("ignores the command-submitting key until the mounted dialog is armed", () => {
  const { calls, controller } = createController()
  const { event, consumed } = keyEvent("return")

  assert.equal(handleLoopDialogKey(event, controller, false), false)
  assert.deepEqual(calls, [])
  assert.deepEqual(consumed, [])
})

test("mouse hover and press select a row while release activates that row", () => {
  const { calls, controller } = createController()
  const handlers = createLoopDialogPointerHandlers(2, controller)

  handlers.onMouseOver()
  handlers.onMouseDown()
  handlers.onMouseUp()

  assert.deepEqual(calls, [
    ["select", 2],
    ["select", 2],
    ["activateAt", 2],
  ])
})
