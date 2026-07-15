# Interactive Loop Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenCode-native Loop dialog with per-task `Copy ID`, global `Copy all`, and explicit `Close` actions, then release and install version 0.2.5.

**Architecture:** Keep the server plugin as scheduler and toast producer. Add a TUI companion entrypoint in the same npm package; it observes plugin-owned `tui.toast.show` events, converts messages into a pure feedback model, and opens a native `DialogSelect`. The built-in toast remains the server-only fallback.

**Tech Stack:** TypeScript, Node test runner, `@opencode-ai/plugin` server/TUI APIs, OpenCode 1.17.18 dialog and keymap APIs, `clipboardy` 4.0.0, npm package exports.

## Global Constraints

- Release exactly `0.2.5`; require OpenCode `>=1.17.18` for the TUI entrypoint.
- Keep scheduling, persistence, tools, session scoping, and all existing tests green.
- `Copy all` writes the exact full feedback message.
- Every distinct task ID gets one `Copy ID`; do not add `Copy all IDs`.
- Server-only loading must continue to show the ordinary toast.
- Runtime code must never write to stdout or stderr.
- GitHub and npm must both display the updated README.

---

### Task 1: Pure Feedback Model

**Files:**
- Create: `src/tui-feedback-model.ts`
- Create: `tests/tui-feedback-model.test.mjs`

**Interfaces:**
- Produces: `LOOP_FEEDBACK_TITLE`, `LOOP_COPY_TITLE`, `extractTaskIds`, `isLoopFeedbackToast`, and `createLoopFeedbackModel`.

- [ ] **Step 1: Write failing tests**

Test creation IDs (`[id=abc123]`), multiple list-row IDs (`[abc123]`), display order, deduplication, malformed-token rejection, and rejection of non-Loop/copy-result toasts.

```js
assert.deepEqual(extractTaskIds("created [id=abc123]"), ["abc123"])
assert.deepEqual(extractTaskIds("[first01] active\n[second2] paused"), ["first01", "second2"])
assert.deepEqual(extractTaskIds("[same123] x\n[id=same123]\n[id=bad id]"), ["same123"])
```

- [ ] **Step 2: Verify RED**

Run `npm run build && node --test tests/tui-feedback-model.test.mjs`.

Expected: FAIL because the model module does not exist.

- [ ] **Step 3: Implement the model**

Use these public shapes:

```ts
export const LOOP_FEEDBACK_TITLE = "Loop · opencode-plugin-loop"
export const LOOP_COPY_TITLE = "Loop copy"
export type LoopFeedbackVariant = "info" | "success" | "warning" | "error"
export type LoopFeedbackModel = {
  message: string
  variant: LoopFeedbackVariant
  taskIds: string[]
}
```

Match only `[A-Za-z0-9_-]+`, capture both canonical formats with match indices, sort by index, then deduplicate without changing display order.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm run build && node --test tests/tui-feedback-model.test.mjs`.

Commit `src/tui-feedback-model.ts` and its test as `feat: model interactive loop feedback`.

---

### Task 2: TUI Companion Controller and Dialog

**Files:**
- Create: `src/tui.ts`
- Create: `tests/tui-plugin.test.mjs`
- Modify: `src/runtime-feedback.ts`

**Interfaces:**
- Consumes: Task 1 model and constants.
- Produces: `LoopTuiPlugin`, `createLoopTuiPlugin(dependencies)`, and default `TuiPluginModule` ID `opencode-plugin-loop-tui`.

- [ ] **Step 1: Write failing fake-API tests**

Build a fake API recording event handlers, dialog replacement/clear, `DialogSelect` props, toast calls, keymap layers, and disposal. Assert:

- a Loop event opens one dialog;
- two IDs create two `{type:"copy-id", id}` options;
- options end with `{type:"copy-all"}` and `{type:"close"}`;
- a later Loop event replaces rather than stacks;
- each ID action copies only its ID;
- Copy all copies the exact message;
- Close and temporary Q binding clear the dialog;
- clipboard failure shows an error toast and leaves the dialog open;
- non-Loop toasts are ignored;
- listeners and keymap layers unregister on close/disposal.

- [ ] **Step 2: Verify RED**

Run `npm run build && node --test tests/tui-plugin.test.mjs`.

Expected: FAIL because `dist/tui.js` does not exist.

- [ ] **Step 3: Implement the dependency-injected companion**

```ts
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import clipboardy from "clipboardy"
import {
  LOOP_COPY_TITLE,
  createLoopFeedbackModel,
  isLoopFeedbackToast,
} from "./tui-feedback-model.js"

type Dependencies = { writeClipboard(text: string): Promise<void> }

export function createLoopTuiPlugin(deps: Dependencies): TuiPlugin {
  return async (api) => {
    let open = false
    let removeCloseLayer: (() => void) | undefined
    const releaseCloseLayer = () => {
      removeCloseLayer?.()
      removeCloseLayer = undefined
    }
    const close = () => api.ui.dialog.clear()
    const copy = async (text: string, label: string) => {
      try {
        await deps.writeClipboard(text)
        api.ui.toast({ title: LOOP_COPY_TITLE, message: `${label} copied`, variant: "success", duration: 2000 })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        api.ui.toast({ title: LOOP_COPY_TITLE, message: `Copy failed: ${message}`, variant: "error", duration: 3500 })
      }
    }
    const unsubscribe = api.event.on("tui.toast.show", (event) => {
      if (!isLoopFeedbackToast(event)) return
      const model = createLoopFeedbackModel(event.properties.message, event.properties.variant)
      api.ui.dialog.clear()
      releaseCloseLayer()
      removeCloseLayer = api.keymap.registerLayer({
        priority: 1000,
        commands: [{ name: "loop.dialog.close", run: close }],
        bindings: [{ key: "q", cmd: "loop.dialog.close" }],
      })
      const options = [
        ...model.taskIds.map((id) => ({ title: `Copy ID: ${id}`, value: { type: "copy-id" as const, id } })),
        { title: "Copy all", value: { type: "copy-all" as const } },
        { title: "Close", value: { type: "close" as const } },
      ]
      open = true
      api.ui.dialog.replace(
        () => api.ui.DialogSelect({
          title: `Loop\n\n${model.message}`,
          options,
          skipFilter: true,
          onSelect(option) {
            const action = option.value
            if (action.type === "close") return close()
            if (action.type === "copy-all") return void copy(model.message, "Loop content")
            return void copy(action.id, `Task ID ${action.id}`)
          },
        }),
        () => {
          open = false
          releaseCloseLayer()
        },
      )
    })
    api.lifecycle.onDispose(() => {
      unsubscribe()
      releaseCloseLayer()
      if (open) api.ui.dialog.clear()
    })
  }
}

export const LoopTuiPlugin = createLoopTuiPlugin({
  writeClipboard: (text) => clipboardy.write(text),
})

export default {
  id: "opencode-plugin-loop-tui",
  tui: LoopTuiPlugin,
} satisfies TuiPluginModule
```

Call `api.ui.dialog.replace(() => api.ui.DialogSelect(...), onClose)`. Put the exact feedback message in the title, set `skipFilter: true`, and use options titled `Copy ID: <id>`, `Copy all`, and `Close`. OpenCode provides mouse, arrows, Enter, Space, and Escape. Register `q -> loop.dialog.close` only for the dialog lifetime. Copy-result toasts use `LOOP_COPY_TITLE` to prevent recursion.

- [ ] **Step 4: Share the stable server title**

Import `LOOP_FEEDBACK_TITLE` into `runtime-feedback.ts` and replace the literal toast title. Preserve message, variant, duration, logging, and command consumption.

- [ ] **Step 5: Verify GREEN and commit**

Run `npm run build && node --test tests/tui-feedback-model.test.mjs tests/tui-plugin.test.mjs tests/integration.test.mjs`.

Commit as `feat: add interactive loop feedback dialog`.

---

### Task 3: Dual Entrypoint Packaging

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/integration.test.mjs`

**Interfaces:**
- Produces: root/server entry at `dist/index` and TUI entry at `dist/tui`.

- [ ] **Step 1: Add failing export assertions**

Assert the server default has `id/server`, the TUI default has `id/tui`, package exports include `./server` and `./tui`, and `engines.opencode` equals `>=1.17.18`.

- [ ] **Step 2: Verify RED**

Run `npm run build && node --test tests/integration.test.mjs`.

Expected: FAIL because the package metadata lacks the new exports.

- [ ] **Step 3: Update metadata**

Keep the backward-compatible root export and add:

```json
"./server": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
"./tui": { "types": "./dist/tui.d.ts", "import": "./dist/tui.js" }
```

Set `engines.opencode` to `>=1.17.18`; add `clipboardy: 4.0.0`; require `@opencode-ai/plugin >=1.17.18`; change test script to `npm run build && node --test tests/*.test.mjs`; run `npm install` to update the lockfile.

- [ ] **Step 4: Verify and commit**

Run `npm test` and `npm publish --dry-run`. Confirm both entrypoints appear in the tarball.

Commit as `build: expose server and TUI plugin entrypoints`.

---

### Task 4: Version 0.2.5 and Current Remote README

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Update README**

Document the exact upgrade command `opencode plugin opencode-plugin-loop@0.2.5 --global --force`, OpenCode 1.17.18 minimum, per-task Copy ID, Copy all, Close/Escape/Q behavior, server-only toast fallback, and stale copied-plugin backup guidance.

- [ ] **Step 2: Bump version**

Run `npm version 0.2.5 --no-git-tag-version` and confirm both package files report 0.2.5.

- [ ] **Step 3: Verify npm README and commit**

Run `npm publish --dry-run`; confirm the 0.2.5 tarball includes the updated README and both entrypoints.

Commit as `chore: prepare 0.2.5 release`.

---

### Task 5: Review, Real TUI Verification, Release, and Local Upgrade

**Files:**
- Verify only; change code only for concrete review or test findings.

- [ ] **Step 1: Run the sequential gate**

Run `npm test`, `npm run build`, `npm publish --dry-run`, `git diff --check`, and `git status --short` sequentially. All must succeed and the worktree must be clean.

- [ ] **Step 2: Independent review**

Review loader compatibility, replacement/disposal, Q binding scope, clipboard errors, fallback, secrets, and README accuracy. Fix Critical/Important findings test-first and repeat Step 1.

- [ ] **Step 3: Real OpenCode 1.17.18 package-path test**

With isolated XDG config/cache, run `/loop list --all` and verify the interactive dialog, each Copy ID, exact Copy all clipboard contents, Close/Escape/Q, no raw task lines below the prompt, and acknowledgement without tools.

- [ ] **Step 4: GitHub release**

Fast-forward to `main`, rerun `npm test`, push `main`, create/push annotated tag `v0.2.5`, and verify remote refs point to the reviewed commit.

- [ ] **Step 5: npm release**

Publish through an ephemeral npmrc and verify `npm view opencode-plugin-loop version dist-tags.latest --json` returns 0.2.5 for both values.

- [ ] **Step 6: Real local upgrade**

Run `opencode plugin opencode-plugin-loop@0.2.5 --global --force`. Confirm server and TUI configs register the package, cache version is 0.2.5, the old 0.2.0 backup remains intact, and the real global OpenCode config passes Copy ID, Copy all, and Close checks.
