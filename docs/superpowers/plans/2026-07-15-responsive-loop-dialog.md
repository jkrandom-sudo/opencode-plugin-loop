# Responsive Loop Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Loop dialog resize safely in short/narrow terminals and close the current dialog immediately after a successful `Copy ID` or `Copy all` action.

**Architecture:** Keep OpenCode's native dialog stack and replace the built-in `DialogSelect` body with a custom OpenTUI Solid component. Pure layout and action helpers remain independent of JSX; `src/tui.ts` retains event ownership, clipboard I/O, generation-safe close behavior, and structured recovery.

**Tech Stack:** TypeScript, Node test runner, OpenCode TUI plugin API 1.17.18, `@opentui/solid` 0.4.3, `@opentui/core` 0.4.3, SolidJS 1.9.12, clipboardy 4.0.0.

## Global Constraints

- OpenCode minimum version remains `>=1.17.18`.
- The server entrypoint must not import OpenTUI, SolidJS, or clipboard code.
- `Copy all` must write the exact complete Loop message without truncation or normalization.
- A clipboard failure must keep the current dialog open.
- A clipboard success may close only the dialog generation that initiated the write.
- The native OpenCode dialog stack continues to own backdrop, modal focus, and `Esc`.
- No direct stdout/stderr writes are allowed from runtime plugin code.
- Root, `./server`, and `./tui` package entrypoints remain backward compatible.

---

## File structure

- Create `src/tui-dialog-layout.ts`: pure responsive row allocation and action-index movement.
- Create `src/tui-dialog-actions.ts`: action construction and generation-safe asynchronous action runner.
- Create `src/tui-dialog-view.tsx`: responsive OpenTUI JSX view, scroll regions, selected-row presentation, and imperative keyboard ref.
- Modify `src/tui.ts`: dialog generation ownership, keyboard layer, copy-close behavior, and view factory injection.
- Create `tests/tui-dialog-layout.test.mjs`: layout and selection regression tests.
- Create `tests/tui-dialog-actions.test.mjs`: copy success/failure, duplicate activation, and replacement-race tests.
- Modify `tests/tui-plugin.test.mjs`: plugin/view integration and lifecycle behavior.
- Modify `tests/package-exports.test.mjs`, `package.json`, `package-lock.json`, and `tsconfig.json`: TSX compilation and compatible OpenTUI peers.
- Modify `README.md`: describe automatic close and responsive scrolling.

### Task 1: Pure responsive layout and action ordering

**Files:**
- Create: `src/tui-dialog-layout.ts`
- Test: `tests/tui-dialog-layout.test.mjs`

**Interfaces:**
- Produces: `allocateLoopDialogRows(terminalRows: number, actionCount: number): LoopDialogRows`
- Produces: `moveLoopActionIndex(current: number, delta: number, count: number): number`
- `LoopDialogRows` is `{ maxHeight: number; messageRows: number; actionRows: number }`.

- [ ] **Step 1: Write failing layout tests**

```js
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
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm run build && node --test tests/tui-dialog-layout.test.mjs`

Expected: FAIL because `dist/tui-dialog-layout.js` does not exist.

- [ ] **Step 3: Implement the pure helpers**

```ts
export interface LoopDialogRows {
  maxHeight: number
  messageRows: number
  actionRows: number
}

export function allocateLoopDialogRows(terminalRows: number, actionCount: number): LoopDialogRows {
  const rows = Math.max(1, Math.floor(terminalRows))
  const available = Math.max(1, rows - 4)
  const maxHeight = Math.min(28, available, Math.max(6, Math.floor(rows * 0.7)))
  const contentRows = Math.max(0, maxHeight - 3)
  if (contentRows < 2) return { maxHeight, messageRows: 0, actionRows: contentRows }
  const actionRows = Math.min(
    Math.max(0, actionCount),
    Math.max(1, Math.min(6, Math.floor(contentRows * 0.4)))
  )
  return { maxHeight, messageRows: contentRows - actionRows, actionRows }
}

export function moveLoopActionIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return ((current + delta) % count + count) % count
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run build && node --test tests/tui-dialog-layout.test.mjs`

Expected: all layout tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui-dialog-layout.ts tests/tui-dialog-layout.test.mjs
git commit -m "feat: model responsive Loop dialog layout"
```

### Task 2: Transactional dialog actions

**Files:**
- Create: `src/tui-dialog-actions.ts`
- Test: `tests/tui-dialog-actions.test.mjs`

**Interfaces:**
- Consumes: task IDs and exact message from `createLoopFeedbackModel`.
- Produces: `LoopDialogAction`, `createLoopDialogActions(taskIds)`, and `createLoopActionRunner(dependencies)`.
- Runner method: `run(action: LoopDialogAction, message: string): Promise<void>` and getter `busy: boolean`.

- [ ] **Step 1: Write failing transactional tests**

```js
test("successful copies close only their current generation", async () => {
  const copied = []
  let current = true
  let closes = 0
  const runner = createLoopActionRunner({
    writeClipboard: async (text) => copied.push(text),
    notifySuccess() {},
    notifyFailure() {},
    closeIfCurrent: () => { if (current) closes++ },
  })
  await runner.run({ type: "copy-id", taskId: "abc123" }, "full message")
  assert.deepEqual(copied, ["abc123"])
  assert.equal(closes, 1)
  current = false
  await runner.run({ type: "copy-all" }, "full message")
  assert.equal(closes, 1)
})

test("clipboard failure keeps the dialog open", async () => {
  let failures = 0
  let closes = 0
  const runner = createLoopActionRunner({
    writeClipboard: async () => { throw new Error("denied") },
    notifySuccess() {},
    notifyFailure: () => failures++,
    closeIfCurrent: () => closes++,
  })
  await runner.run({ type: "copy-all" }, "exact")
  assert.equal(failures, 1)
  assert.equal(closes, 0)
})

test("duplicate activation is ignored while copying", async () => {
  let release
  let writes = 0
  const runner = createLoopActionRunner({
    writeClipboard: () => new Promise((resolve) => { writes++; release = resolve }),
    notifySuccess() {}, notifyFailure() {}, closeIfCurrent() {},
  })
  const first = runner.run({ type: "copy-all" }, "exact")
  const second = runner.run({ type: "copy-all" }, "exact")
  assert.equal(writes, 1)
  release()
  await Promise.all([first, second])
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm run build && node --test tests/tui-dialog-actions.test.mjs`

Expected: FAIL because the action module does not exist.

- [ ] **Step 3: Implement ordered actions and runner**

```ts
export type LoopDialogAction =
  | { type: "copy-id"; taskId: string }
  | { type: "copy-all" }
  | { type: "close" }

export function createLoopDialogActions(taskIds: readonly string[]): readonly LoopDialogAction[] {
  return [
    ...taskIds.map((taskId) => ({ type: "copy-id" as const, taskId })),
    { type: "copy-all" as const },
    { type: "close" as const },
  ]
}

export function createLoopActionRunner(input: {
  writeClipboard(text: string): Promise<void>
  notifySuccess(description: string): void
  notifyFailure(): void
  closeIfCurrent(): void
}) {
  let busy = false
  return {
    get busy() { return busy },
    async run(action: LoopDialogAction, message: string) {
      if (action.type === "close") return input.closeIfCurrent()
      if (busy) return
      busy = true
      const text = action.type === "copy-all" ? message : action.taskId
      const description = action.type === "copy-all" ? "Loop result" : `Task ID ${action.taskId}`
      try {
        await input.writeClipboard(text)
        input.notifySuccess(description)
        input.closeIfCurrent()
      } catch {
        input.notifyFailure()
      } finally {
        busy = false
      }
    },
  }
}
```

- [ ] **Step 4: Run action and layout tests**

Run: `npm run build && node --test tests/tui-dialog-actions.test.mjs tests/tui-dialog-layout.test.mjs`

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui-dialog-actions.ts tests/tui-dialog-actions.test.mjs
git commit -m "feat: add transactional Loop dialog actions"
```

### Task 3: Responsive OpenTUI dialog view

**Files:**
- Create: `src/tui-dialog-view.tsx`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/package-exports.test.mjs`

**Interfaces:**
- Consumes: `LoopDialogAction[]`, exact message, variant, `TuiPluginApi`, and `allocateLoopDialogRows`.
- Produces: `LoopFeedbackDialog(input): JSX.Element` and `LoopFeedbackDialogRef` with `move`, `activate`, `pageMessage`, and `dispose` methods.

- [ ] **Step 1: Add failing packaging assertions**

```js
test("declares the host TUI peers used by the responsive dialog", () => {
  assert.equal(packageJson.peerDependencies["@opentui/core"], ">=0.4.3")
  assert.equal(packageJson.peerDependencies["@opentui/solid"], ">=0.4.3")
  assert.equal(packageJson.peerDependencies["solid-js"], "1.9.12")
})
```

- [ ] **Step 2: Run the package test and verify RED**

Run: `node --test tests/package-exports.test.mjs`

Expected: FAIL because the OpenTUI peers are absent.

- [ ] **Step 3: Add compatible compile/runtime metadata**

Run:

```bash
npm install --save-dev @opentui/core@0.4.3 @opentui/solid@0.4.3 solid-js@1.9.12
npm pkg set 'peerDependencies.@opentui/core=>=0.4.3' \
  'peerDependencies.@opentui/solid=>=0.4.3' \
  'peerDependencies.solid-js=1.9.12'
```

Add to `compilerOptions` in `tsconfig.json`:

```json
"jsx": "react-jsx",
"jsxImportSource": "@opentui/solid"
```

- [ ] **Step 4: Implement the responsive TSX view**

Use `useTerminalDimensions`, `createSignal`, `createEffect`, `ScrollBoxRenderable`, and the live OpenCode theme. The root box uses `maxHeight={rows().maxHeight}`; the message and action `scrollbox` elements use `rows().messageRows` and `rows().actionRows`. Implement the view with this complete structure:

```ts
/** @jsxImportSource @opentui/solid */
import { RGBA, TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui"

import type { LoopDialogAction } from "./tui-dialog-actions.js"
import { allocateLoopDialogRows, moveLoopActionIndex } from "./tui-dialog-layout.js"

export interface LoopFeedbackDialogRef {
  move(delta: number): void
  activate(): void
  pageMessage(delta: number): void
  dispose(): void
}

export interface LoopFeedbackDialogProps {
  message: string
  variant: "info" | "success" | "warning" | "error"
  actions: readonly LoopDialogAction[]
  theme: TuiThemeCurrent
  onActivate(action: LoopDialogAction): void | Promise<void>
  ref?(value: LoopFeedbackDialogRef | undefined): void
}

const transparent = RGBA.fromInts(0, 0, 0, 0)

const label = (action: LoopDialogAction) =>
  action.type === "copy-id" ? `Copy ID: ${action.taskId}` : action.type === "copy-all" ? "Copy all" : "Close"

const description = (action: LoopDialogAction) =>
  action.type === "copy-id"
    ? "Copy this task ID"
    : action.type === "copy-all"
      ? "Copy the complete Loop result"
      : "Close this Loop result"

export function LoopFeedbackDialog(props: LoopFeedbackDialogProps): JSX.Element {
  const dimensions = useTerminalDimensions()
  const [selected, setSelected] = createSignal(0)
  const rows = createMemo(() => allocateLoopDialogRows(dimensions().height, props.actions.length))
  let messageScroll: ScrollBoxRenderable | undefined
  let actionScroll: ScrollBoxRenderable | undefined

  const keepSelectedVisible = () => {
    const scroll = actionScroll
    const target = scroll?.getChildren()[selected()]
    if (!scroll || !target) return
    const offset = target.y - scroll.y
    if (offset < 0) scroll.scrollBy(offset)
    if (offset >= scroll.height) scroll.scrollBy(offset - scroll.height + 1)
  }

  const controller: LoopFeedbackDialogRef = {
    move(delta) {
      setSelected((index) => moveLoopActionIndex(index, delta, props.actions.length))
    },
    activate() {
      const action = props.actions[selected()]
      if (action) void props.onActivate(action)
    },
    pageMessage(delta) {
      if (!messageScroll) return
      messageScroll.scrollBy(delta * Math.max(1, messageScroll.height - 1))
    },
    dispose() {
      messageScroll = undefined
      actionScroll = undefined
    },
  }

  props.ref?.(controller)
  createEffect(() => {
    selected()
    queueMicrotask(keepSelectedVisible)
  })
  onCleanup(() => {
    controller.dispose()
    props.ref?.(undefined)
  })

  const icon = () => ({ info: "ℹ", success: "✓", warning: "⚠", error: "✕" })[props.variant]

  return (
    <box maxHeight={rows().maxHeight} flexDirection="column" gap={1} paddingBottom={1}>
      <box paddingLeft={3} paddingRight={3} flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={props.theme.text} attributes={TextAttributes.BOLD}>{icon()} Loop</text>
        <text fg={props.theme.textMuted}>esc</text>
      </box>
      <Show when={rows().messageRows > 0}>
        <scrollbox
          ref={(value: ScrollBoxRenderable) => (messageScroll = value)}
          maxHeight={rows().messageRows}
          paddingLeft={3}
          paddingRight={3}
          scrollbarOptions={{ visible: true }}
        >
          <text fg={props.theme.text}>{props.message}</text>
        </scrollbox>
      </Show>
      <Show when={rows().actionRows > 0}>
        <scrollbox
          ref={(value: ScrollBoxRenderable) => (actionScroll = value)}
          maxHeight={rows().actionRows}
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
        >
          <For each={props.actions}>{(action, index) => {
            const active = () => selected() === index()
            return (
              <box
                paddingLeft={2}
                paddingRight={2}
                flexDirection="row"
                gap={1}
                backgroundColor={active() ? props.theme.primary : transparent}
                onMouseDown={() => setSelected(index())}
                onMouseUp={() => void props.onActivate(action)}
              >
                <text fg={active() ? props.theme.selectedListItemText : props.theme.text} attributes={active() ? TextAttributes.BOLD : undefined}>
                  {label(action)}
                </text>
                <text fg={active() ? props.theme.selectedListItemText : props.theme.textMuted}>{description(action)}</text>
              </box>
            )
          }}</For>
        </scrollbox>
      </Show>
    </box>
  )
}
```

The message text uses OpenTUI's normal wrapping, so the scrollbox—not a title row—owns the wrapped height.

- [ ] **Step 5: Build and verify package tests GREEN**

Run: `npm run build && node --test tests/package-exports.test.mjs tests/tui-dialog-layout.test.mjs`

Expected: build succeeds and all focused tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui-dialog-view.tsx tsconfig.json package.json package-lock.json tests/package-exports.test.mjs
git commit -m "feat: render responsive Loop feedback dialog"
```

### Task 4: Integrate copy-close and responsive keyboard lifecycle

**Files:**
- Modify: `src/tui.ts`
- Modify: `tests/tui-plugin.test.mjs`

**Interfaces:**
- Consumes: `createLoopDialogActions`, `createLoopActionRunner`, `LoopFeedbackDialog`, and `LoopFeedbackDialogRef`.
- Preserves: default export `{ id: "opencode-plugin-loop-tui", tui }`.

- [ ] **Step 1: Change integration tests to require close-on-success**

Update `Copy ID` and `Copy all` tests so each asserts:

```js
assert.equal(api.ui.dialog.open, true)
select(api, "Copy ID: task01")
await settle()
assert.deepEqual(copied, ["task01"])
assert.equal(api.ui.dialog.open, false)
assert.equal(api.__layers.filter((layer) => layer.active).length, 0)
```

Keep the clipboard-error test asserting `api.ui.dialog.open === true`.

Add a deferred clipboard test that opens a second Loop event before the first copy resolves and asserts the second dialog remains open.

- [ ] **Step 2: Run focused integration tests and verify RED**

Run: `npm run build && node --test tests/tui-plugin.test.mjs`

Expected: copy-success assertions FAIL because the dialog remains open.

- [ ] **Step 3: Integrate generations, runner, view factory, and keymap**

Extend `LoopTuiDependencies` with an injectable `renderDialog` factory. For each `openFeedback` call:

```ts
const generation = ++latestGeneration
ownedGeneration = generation
const actions = createLoopDialogActions(model.taskIds)
const runner = createLoopActionRunner({
  writeClipboard: dependencies.writeClipboard,
  notifySuccess,
  notifyFailure,
  closeIfCurrent: () => closeGeneration(generation),
})
```

Register commands for previous/next action, activate, message page up/down, and close. Bind `up`, `down`, `enter`, `return`, `space`, `pageup`, `pagedown`, and `q`; retain native `Esc`. Render through the injected factory and clear the keyboard ref in `onClose`.

- [ ] **Step 4: Run focused integration tests and verify GREEN**

Run: `npm run build && node --test tests/tui-plugin.test.mjs tests/tui-dialog-actions.test.mjs`

Expected: all focused tests PASS, including failure recovery and replacement race.

- [ ] **Step 5: Commit**

```bash
git add src/tui.ts tests/tui-plugin.test.mjs
git commit -m "feat: close Loop feedback after successful copy"
```

### Task 5: Documentation, version, and release artifact

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/package-exports.test.mjs`

**Interfaces:**
- Produces: npm artifact version `0.2.6` with current GitHub/npm README.

- [ ] **Step 1: Add a failing version assertion**

```js
test("publishes the responsive dialog release", () => {
  assert.equal(packageJson.version, "0.2.6")
})
```

- [ ] **Step 2: Verify the assertion is RED**

Run: `node --test tests/package-exports.test.mjs`

Expected: FAIL with actual version `0.2.5`.

- [ ] **Step 3: Bump version and update README**

Run: `npm version 0.2.6 --no-git-tag-version`

Document that successful copy closes the dialog, failed copy stays open, and short terminals use independently scrollable message/action regions. Change pinned installation examples from `0.2.5` to `0.2.6`.

- [ ] **Step 4: Run the full automated gate**

Run: `npm test && npm publish --dry-run && git diff --check`

Expected: all tests PASS; dry-run contains `dist/tui-dialog-view.js`, responsive helper modules, README, and version `0.2.6`.

- [ ] **Step 5: Commit**

```bash
git add README.md package.json package-lock.json tests/package-exports.test.mjs
git commit -m "docs: prepare responsive Loop dialog release"
```

### Task 6: Review and real OpenCode resize verification

**Files:**
- No production file changes unless verification exposes a defect.

- [ ] **Step 1: Run final static and automated checks from a clean tree**

Run:

```bash
npm ci
npm test
npm publish --dry-run
git diff --check
git status --short
```

Expected: 0 failures, valid 0.2.6 tarball, and no tracked changes.

- [ ] **Step 2: Install the branch into an isolated OpenCode config**

Run `opencode plugin file:///absolute/path/to/worktree --global --force` with isolated `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`, then copy `commands/loop.md` into the isolated OpenCode commands directory.

Expected: installer reports `Detected server + tui targets`.

- [ ] **Step 3: Verify normal and narrow PTYs**

Start OpenCode 1.17.18 after `stty rows 30 cols 100`, run `/loop 1m responsive verification`, and verify full message, `Copy ID`, `Copy all`, and `Close`. Resize the active PTY with `stty rows 16 cols 58`; verify the dialog stays within the viewport, both regions scroll, the selected action stays visible, and the prompt remains unobstructed.

- [ ] **Step 4: Verify copy semantics**

Select `Copy ID` and confirm the exact stored ID is in the clipboard and the dialog closes. Reopen with `/loop list`, select `Copy all`, confirm exact message equality and automatic close. Inject or simulate clipboard failure and verify the dialog remains open with an error toast.

- [ ] **Step 5: Request code review and address findings**

Review the complete range from `a6c5989` to the implementation HEAD, with emphasis on OpenTUI dependency identity, responsive overflow, async generation races, cleanup, and server-only import isolation.

- [ ] **Step 6: Run the verification-before-completion gate**

Repeat `npm test`, `npm publish --dry-run`, `git diff --check`, `git status --short`, and the focused real OpenCode scenario after any review fixes. Do not push or publish until all fresh evidence passes.
