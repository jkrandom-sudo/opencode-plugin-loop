import assert from "node:assert/strict"
import test from "node:test"

import LoopTuiModule, { createLoopTuiPlugin } from "../dist/tui.js"
import { LOOP_COPY_TITLE, LOOP_FEEDBACK_TITLE } from "../dist/tui-feedback-model.js"

function createFakeApi() {
  const eventHandlers = new Map()
  const disposers = []
  const toasts = []
  const logs = []
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
    client: {
      app: {
        async log(input) {
          logs.push(input)
        },
      },
    },
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
    theme: { current: {} },
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
    __logs: logs,
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

function createTestLoopTuiPlugin(dependencies = {}) {
  return createLoopTuiPlugin({
    writeClipboard: async () => {},
    renderDialog(props) {
      return props
    },
    ...dependencies,
  })
}

function select(api, title) {
  const view = api.__view()
  const action = view.actions.find((candidate) => {
    if (candidate.type === "copy-id") return `Copy ID: ${candidate.taskId}` === title
    if (candidate.type === "copy-all") return title === "Copy all"
    return title === "Close"
  })
  assert.ok(action, `missing dialog action: ${title}`)
  view.onActivate(action)
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test("exports a TUI-only OpenCode plugin module", () => {
  assert.equal(LoopTuiModule.id, "opencode-plugin-loop-tui")
  assert.equal(typeof LoopTuiModule.tui, "function")
  assert.equal(LoopTuiModule.server, undefined)
})

test("shows variant-aware status treatment in the dialog title", async () => {
  const api = createFakeApi()
  await createTestLoopTuiPlugin()(api)

  emitLoop(api, "Created", "success")
  assert.equal(api.__view().variant, "success")
  emitLoop(api, "Failed", "error")
  assert.equal(api.__view().variant, "error")
})

test("opens one native dialog with per-task copy actions", async () => {
  const api = createFakeApi()
  const copied = []
  await createTestLoopTuiPlugin({
    writeClipboard: async (text) => copied.push(text),
  })(api)

  emitLoop(api, "[first01] active\n[second2] paused")

  assert.equal(api.ui.dialog.open, true)
  assert.equal(api.ui.dialog.depth, 1)
  assert.match(api.__view().message, /\[first01\] active/)
  assert.deepEqual(
    api.__view().actions.map((action) =>
      action.type === "copy-id" ? `Copy ID: ${action.taskId}` : action.type === "copy-all" ? "Copy all" : "Close"
    ),
    ["Copy ID: first01", "Copy ID: second2", "Copy all", "Close"],
  )

  select(api, "Copy ID: second2")
  await settle()
  assert.deepEqual(copied, ["second2"])
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)
})

test("copies the exact complete feedback text", async () => {
  const api = createFakeApi()
  const copied = []
  await createTestLoopTuiPlugin({
    writeClipboard: async (text) => copied.push(text),
  })(api)
  const message = "Loop started [id=abc123]\nCancel: /loop cancel abc123"

  emitLoop(api, message, "success")
  select(api, "Copy all")
  await settle()

  assert.deepEqual(copied, [message])
  assert.equal(api.__toasts.at(-1).title, LOOP_COPY_TITLE)
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)
})

test("keeps the dialog open and reports clipboard errors without recursion", async () => {
  const api = createFakeApi()
  await createTestLoopTuiPlugin({
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
  await createTestLoopTuiPlugin()(api)

  emitLoop(api, "Loop started [id=first01]", "success")
  const firstLayer = api.__layers.at(-1)
  emitLoop(api, "Loop started [id=second2]", "success")

  assert.equal(api.ui.dialog.depth, 1)
  assert.match(api.__view().message, /second2/)
  assert.equal(firstLayer.active, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 1)
})

test("closes from the action or temporary q shortcut", async () => {
  const api = createFakeApi()
  await createTestLoopTuiPlugin()(api)

  emitLoop(api, "No loop tasks found")
  select(api, "Close")
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)

  emitLoop(api, "No loop tasks found")
  const layer = api.__layers.findLast((candidate) => candidate.active).layer
  layer.commands.find((command) => command.name === "loop.dialog.close").run()
  assert.equal(api.ui.dialog.open, false)
})

test("keyboard commands drive the responsive view and Enter closes after copy", async () => {
  const api = createFakeApi()
  const copied = []
  const pageDeltas = []
  let selected = 0
  await createTestLoopTuiPlugin({
    writeClipboard: async (text) => copied.push(text),
    renderDialog(props) {
      props.ref({
        move(delta) {
          selected = (selected + delta + props.actions.length) % props.actions.length
        },
        activate() {
          props.onActivate(props.actions[selected])
        },
        pageMessage(delta) {
          pageDeltas.push(delta)
        },
        dispose() {},
      })
      return props
    },
  })(api)

  emitLoop(api, "Loop started [id=abc123]", "success")
  const layer = api.__layers.findLast((candidate) => candidate.active).layer
  const run = (name) => layer.commands.find((command) => command.name === name).run()
  assert.deepEqual(
    layer.bindings.map((binding) => binding.key),
    ["up", "down", "enter", "return", "space", "pageup", "pagedown", "q"],
  )

  run("loop.dialog.next")
  run("loop.dialog.page-down")
  run("loop.dialog.activate")
  await settle()

  assert.deepEqual(pageDeltas, [1])
  assert.deepEqual(copied, ["Loop started [id=abc123]"])
  assert.equal(api.ui.dialog.open, false)
})

test("a slow copy from a replaced dialog cannot close the current dialog", async () => {
  const api = createFakeApi()
  let resolveCopy
  await createTestLoopTuiPlugin({
    writeClipboard: () => new Promise((resolve) => {
      resolveCopy = resolve
    }),
  })(api)

  emitLoop(api, "Loop started [id=first01]", "success")
  select(api, "Copy ID: first01")
  emitLoop(api, "Loop started [id=second2]", "success")
  assert.match(api.__view().message, /second2/)

  resolveCopy()
  await settle()
  assert.equal(api.ui.dialog.open, true)
  assert.match(api.__view().message, /second2/)
})

test("ignores unrelated toasts and cleans up all owned state on disposal", async () => {
  const api = createFakeApi()
  await createTestLoopTuiPlugin()(api)

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

test("cleans up and logs when dialog rendering fails, then recovers", async () => {
  const api = createFakeApi()
  let failRender = true
  await createTestLoopTuiPlugin({
    renderDialog(props) {
      if (failRender) throw new Error("render failed")
      return props
    },
  })(api)

  assert.doesNotThrow(() => emitLoop(api, "First [id=first01]", "success"))
  await settle()
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)
  assert.equal(api.__logs.length, 1)
  assert.equal(api.__logs[0].service, "opencode-plugin-loop")
  assert.equal(api.__logs[0].level, "warn")
  assert.match(api.__logs[0].message, /dialog/i)

  failRender = false
  emitLoop(api, "Second [id=second2]", "success")
  assert.equal(api.ui.dialog.open, true)
  assert.match(api.__view().message, /second2/)
})

test("does not leak state when close-layer registration fails", async () => {
  const api = createFakeApi()
  const registerLayer = api.keymap.registerLayer
  let failRegistration = true
  api.keymap.registerLayer = (layer) => {
    if (failRegistration) throw new Error("keymap failed")
    return registerLayer(layer)
  }
  await createTestLoopTuiPlugin()(api)

  assert.doesNotThrow(() => emitLoop(api, "First [id=first01]", "success"))
  await settle()
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)
  assert.equal(api.__logs.length, 1)

  failRegistration = false
  emitLoop(api, "Second [id=second2]", "success")
  assert.equal(api.ui.dialog.open, true)
})
