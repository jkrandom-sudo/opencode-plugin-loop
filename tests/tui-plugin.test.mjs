import assert from "node:assert/strict"
import test from "node:test"

import LoopTuiModule, { createLoopTuiPlugin } from "../dist/tui.js"
import { LOOP_COPY_TITLE } from "../dist/tui-feedback-model.js"

const TEST_DIR = "/tmp/loop-tui-plugin-test"

function createFakeApi() {
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

function createTestLoopTuiPlugin(dependencies = {}) {
  const feedbackHandlers = []
  const unwatchCalls = []
  const plugin = createLoopTuiPlugin({
    writeClipboard: async () => {},
    renderDialog(props) {
      return props
    },
    getDirectory: async () => TEST_DIR,
    watchFeedback(storageDir, onFeedback) {
      feedbackHandlers.push(onFeedback)
      return () => unwatchCalls.push(storageDir)
    },
    ...dependencies,
  })
  const emitLoop = (message, overrides = {}) => {
    const payload = {
      directory: TEST_DIR,
      message,
      ts: Date.now(),
      ...overrides,
    }
    for (const handler of feedbackHandlers) handler(payload)
  }
  return { plugin, emitLoop, unwatchCalls, feedbackHandlers }
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

test("opens the dialog when task list feedback arrives", async () => {
  const api = createFakeApi()
  const { plugin, emitLoop } = createTestLoopTuiPlugin()
  await plugin(api)

  emitLoop("📋 1 loop task(s):\n  [abc123] ▶ active • every 60s • work")
  assert.equal(api.ui.dialog.open, true)
  assert.equal(api.__view().variant, "info")
})

test("ignores stale feedback and feedback from other directories", async () => {
  const api = createFakeApi()
  const { plugin, emitLoop } = createTestLoopTuiPlugin()
  await plugin(api)

  emitLoop("📋 stale", { ts: Date.now() - 60_000 })
  assert.equal(api.ui.dialog.open, false)

  emitLoop("📋 elsewhere", { directory: "/somewhere/else" })
  assert.equal(api.ui.dialog.open, false)

  emitLoop("📋 current")
  assert.equal(api.ui.dialog.open, true)
})

test("passes parsed tasks to the dialog view", async () => {
  const api = createFakeApi()
  const { plugin, emitLoop } = createTestLoopTuiPlugin()
  await plugin(api)

  emitLoop(
    "📋 2 loop task(s):\n  [first01] ▶ active • every 60s • check the build\n  [second2] ⏸ paused • every 30s • once • ping",
  )

  assert.deepEqual(api.__view().tasks, [
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
      interval: "every 30s",
      prompt: "ping",
      once: true,
    },
  ])
})

test("opens one native dialog with per-task copy actions", async () => {
  const api = createFakeApi()
  const copied = []
  const { plugin, emitLoop } = createTestLoopTuiPlugin({
    writeClipboard: async (text) => copied.push(text),
  })
  await plugin(api)

  emitLoop("[first01] active\n[second2] paused")

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
  const { plugin, emitLoop } = createTestLoopTuiPlugin({
    writeClipboard: async (text) => copied.push(text),
  })
  await plugin(api)
  const message = "📋 1 loop task(s):\n  [abc123] ▶ active • every 60s • work"

  emitLoop(message)
  select(api, "Copy all")
  await settle()

  assert.deepEqual(copied, [message])
  assert.equal(api.__toasts.at(-1).title, LOOP_COPY_TITLE)
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)
})

test("keeps the dialog open and reports clipboard errors without recursion", async () => {
  const api = createFakeApi()
  const { plugin, emitLoop } = createTestLoopTuiPlugin({
    writeClipboard: async () => {
      throw new Error("clipboard unavailable")
    },
  })
  await plugin(api)

  emitLoop("📋 1 loop task(s):\n  [abc123] ▶ active • every 60s • work")
  select(api, "Copy ID: abc123")
  await settle()

  assert.equal(api.ui.dialog.open, true)
  assert.equal(api.__toasts.length, 1)
  assert.equal(api.__toasts[0].title, LOOP_COPY_TITLE)
  assert.equal(api.__toasts[0].variant, "error")
})

test("replaces prior Loop feedback instead of stacking dialogs", async () => {
  const api = createFakeApi()
  const { plugin, emitLoop } = createTestLoopTuiPlugin()
  await plugin(api)

  emitLoop("📋 1 loop task(s):\n  [first01] ▶ active • every 60s • work")
  emitLoop("📋 1 loop task(s):\n  [second2] ▶ active • every 30s • work")

  assert.equal(api.ui.dialog.depth, 1)
  assert.match(api.__view().message, /second2/)
  assert.equal(api.__layers.length, 0)
})

test("closes from the action or mounted view callback", async () => {
  const api = createFakeApi()
  const { plugin, emitLoop } = createTestLoopTuiPlugin()
  await plugin(api)

  emitLoop("No loop tasks found")
  select(api, "Close")
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)

  emitLoop("No loop tasks found")
  api.__view().onClose()
  assert.equal(api.ui.dialog.open, false)
})

test("mounts dialog interaction without a plugin-level keymap layer", async () => {
  const api = createFakeApi()
  const { plugin, emitLoop } = createTestLoopTuiPlugin()
  await plugin(api)

  emitLoop("📋 1 loop task(s):\n  [abc123] ▶ active • every 60s • work")
  assert.equal(api.ui.dialog.open, true)
  assert.equal(typeof api.__view().onClose, "function")
  assert.equal(api.__layers.length, 0)
})

test("a slow copy from a replaced dialog cannot close the current dialog", async () => {
  const api = createFakeApi()
  let resolveCopy
  const { plugin, emitLoop } = createTestLoopTuiPlugin({
    writeClipboard: () => new Promise((resolve) => {
      resolveCopy = resolve
    }),
  })
  await plugin(api)

  emitLoop("📋 1 loop task(s):\n  [first01] ▶ active • every 60s • work")
  select(api, "Copy ID: first01")
  emitLoop("📋 1 loop task(s):\n  [second2] ▶ active • every 30s • work")
  assert.match(api.__view().message, /second2/)

  resolveCopy()
  await settle()
  assert.equal(api.ui.dialog.open, true)
  assert.match(api.__view().message, /second2/)
})

test("stops watching and closes the dialog on disposal", async () => {
  const api = createFakeApi()
  const { plugin, emitLoop, unwatchCalls } = createTestLoopTuiPlugin()
  await plugin(api)

  emitLoop("📋 1 loop task(s):\n  [abc123] ▶ active • every 60s • work")
  assert.equal(api.ui.dialog.open, true)

  await api.__dispose()
  assert.equal(api.ui.dialog.open, false)
  assert.equal(unwatchCalls.length, 1)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)
})

test("cleans up and logs when dialog rendering fails, then recovers", async () => {
  const api = createFakeApi()
  let failRender = true
  const { plugin, emitLoop } = createTestLoopTuiPlugin({
    renderDialog(props) {
      if (failRender) throw new Error("render failed")
      return props
    },
  })
  await plugin(api)

  assert.doesNotThrow(() =>
    emitLoop("📋 1 loop task(s):\n  [first01] ▶ active • every 60s • work"))
  await settle()
  assert.equal(api.ui.dialog.open, false)
  assert.equal(api.__layers.filter((layer) => layer.active).length, 0)
  assert.equal(api.__logs.length, 1)
  assert.equal(api.__logs[0].service, "opencode-plugin-loop")
  assert.equal(api.__logs[0].level, "warn")
  assert.match(api.__logs[0].message, /dialog/i)

  failRender = false
  emitLoop("📋 1 loop task(s):\n  [second2] ▶ active • every 30s • work")
  assert.equal(api.ui.dialog.open, true)
  assert.match(api.__view().message, /second2/)
})

test("does not depend on plugin-level keymap registration", async () => {
  const api = createFakeApi()
  api.keymap.registerLayer = () => {
    throw new Error("plugin-level keymap registration is forbidden")
  }
  const { plugin, emitLoop } = createTestLoopTuiPlugin()
  await plugin(api)

  emitLoop("📋 1 loop task(s):\n  [second2] ▶ active • every 30s • work")
  assert.equal(api.ui.dialog.open, true)
  assert.equal(api.__logs.length, 0)
})
