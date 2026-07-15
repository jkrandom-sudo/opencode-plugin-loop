import assert from "node:assert/strict"
import test from "node:test"

import LoopTuiModule, { createLoopTuiPlugin } from "../dist/tui.js"
import { LOOP_COPY_TITLE, LOOP_FEEDBACK_TITLE } from "../dist/tui-feedback-model.js"

function createFakeApi() {
  const eventHandlers = new Map()
  const disposers = []
  const toasts = []
  const layers = []
  let dialogEntry

  const dialog = {
    get depth() {
      return dialogEntry ? 1 : 0
    },
    get open() {
      return Boolean(dialogEntry)
    },
    size: "medium",
    setSize(size) {
      this.size = size
    },
    replace(render, onClose) {
      if (dialogEntry?.onClose) dialogEntry.onClose()
      dialogEntry = { view: render(), onClose }
    },
    clear() {
      const entry = dialogEntry
      dialogEntry = undefined
      entry?.onClose?.()
    },
  }

  return {
    event: {
      on(type, handler) {
        eventHandlers.set(type, handler)
        return () => eventHandlers.delete(type)
      },
    },
    ui: {
      dialog,
      DialogSelect(props) {
        return props
      },
      toast(input) {
        toasts.push(input)
      },
    },
    keymap: {
      registerLayer(layer) {
        const record = { layer, active: true }
        layers.push(record)
        return () => {
          record.active = false
        }
      },
    },
    lifecycle: {
      onDispose(fn) {
        disposers.push(fn)
        return () => {
          const index = disposers.indexOf(fn)
          if (index >= 0) disposers.splice(index, 1)
        }
      },
    },
    __emit(type, event) {
      eventHandlers.get(type)?.(event)
    },
    __view() {
      return dialogEntry?.view
    },
    __toasts: toasts,
    __layers: layers,
    async __dispose() {
      for (const dispose of [...disposers]) await dispose()
    },
  }
}

function emitLoop(api, message, variant = "info") {
  api.__emit("tui.toast.show", {
    type: "tui.toast.show",
    properties: {
      title: LOOP_FEEDBACK_TITLE,
      message,
      variant,
      duration: 5000,
    },
  })
}

function select(api, title) {
  const view = api.__view()
  const option = view.options.find((candidate) => candidate.title === title)
  assert.ok(option, `missing dialog option: ${title}`)
  view.onSelect(option)
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("exports a TUI-only OpenCode plugin module", () => {
  assert.equal(LoopTuiModule.id, "opencode-plugin-loop")
  assert.equal(typeof LoopTuiModule.tui, "function")
  assert.equal(LoopTuiModule.server, undefined)
})

test("opens one native dialog with per-task copy actions", async () => {
  const api = createFakeApi()
  const copied = []
  await createLoopTuiPlugin({ writeClipboard: async (text) => copied.push(text) })(api)

  emitLoop(api, "[first01] active\n[second2] paused")

  assert.equal(api.ui.dialog.open, true)
  assert.equal(api.ui.dialog.depth, 1)
  assert.match(api.__view().title, /\[first01\] active/)
  assert.deepEqual(
    api.__view().options.map((option) => option.title),
    ["Copy ID: first01", "Copy ID: second2", "Copy all", "Close"],
  )

  select(api, "Copy ID: second2")
  await settle()
  assert.deepEqual(copied, ["second2"])
  assert.equal(api.ui.dialog.open, true)
})

test("copies the exact complete feedback text", async () => {
  const api = createFakeApi()
  const copied = []
  await createLoopTuiPlugin({ writeClipboard: async (text) => copied.push(text) })(api)
  const message = "Loop started [id=abc123]\nCancel: /loop cancel abc123"

  emitLoop(api, message, "success")
  select(api, "Copy all")
  await settle()

  assert.deepEqual(copied, [message])
  assert.equal(api.__toasts.at(-1).title, LOOP_COPY_TITLE)
  assert.equal(api.ui.dialog.open, true)
})

test("keeps the dialog open and reports clipboard errors without recursion", async () => {
  const api = createFakeApi()
  await createLoopTuiPlugin({
    writeClipboard: async () => {
      throw new Error("clipboard unavailable")
    },
  })(api)

  emitLoop(api, "Loop started [id=abc123]", "success")
  select(api, "Copy ID: abc123")
  await settle()

  assert.equal(api.ui.dialog.open, true)
  assert.equal(api.__toasts.length, 1)
  assert.equal(api.__toasts[0].title, LOOP_COPY_TITLE)
  assert.equal(api.__toasts[0].variant, "error")
})

test("replaces prior Loop feedback instead of stacking dialogs", async () => {
  const api = createFakeApi()
  await createLoopTuiPlugin({ writeClipboard: async () => {} })(api)

  emitLoop(api, "Loop started [id=first01]", "success")
  const firstLayer = api.__layers.at(-1)
  emitLoop(api, "Loop started [id=second2]", "success")

  assert.equal(api.ui.dialog.depth, 1)
  assert.match(api.__view().title, /second2/)
  assert.equal(firstLayer.active, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 1)
})

test("closes from the action or temporary q shortcut", async () => {
  const api = createFakeApi()
  await createLoopTuiPlugin({ writeClipboard: async () => {} })(api)

  emitLoop(api, "No loop tasks found")
  select(api, "Close")
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)

  emitLoop(api, "No loop tasks found")
  const layer = api.__layers.findLast((candidate) => candidate.active).layer
  layer.commands[0].run()
  assert.equal(api.ui.dialog.open, false)
})

test("ignores unrelated toasts and cleans up all owned state on disposal", async () => {
  const api = createFakeApi()
  await createLoopTuiPlugin({ writeClipboard: async () => {} })(api)

  api.__emit("tui.toast.show", {
    type: "tui.toast.show",
    properties: { title: LOOP_COPY_TITLE, message: "Copied", variant: "success" },
  })
  assert.equal(api.ui.dialog.open, false)

  emitLoop(api, "Loop started [id=abc123]", "success")
  await api.__dispose()
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)

  emitLoop(api, "Loop started [id=after01]", "success")
  assert.equal(api.ui.dialog.open, false)
})
