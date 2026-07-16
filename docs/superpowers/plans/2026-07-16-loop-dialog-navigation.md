# Loop Dialog Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Loop dialog action selectable and activatable with real keyboard and mouse input, then release the verified fix as 0.2.8.

**Architecture:** The mounted Solid dialog owns keyboard input through `useKeyboard`, while pure helper functions translate key and pointer events into controller operations. `src/tui.ts` keeps dialog generation and clipboard ownership but no longer creates a competing plugin-level keymap layer.

**Tech Stack:** TypeScript, Node.js test runner, SolidJS 1.9.12, OpenCode TUI API 1.17.18, OpenTUI 0.4.3, npm.

## Global Constraints

- OpenCode minimum version remains `>=1.17.18`.
- `Copy ID` and `Copy all` close only after a successful clipboard write.
- Clipboard failure keeps the current dialog open.
- The native OpenCode dialog stack continues to own `Esc`, backdrop, and modal focus.
- Runtime code writes no text directly to stdout or stderr.
- Existing Loop tasks on the user's machine are not changed by validation.
- Root, `./server`, and `./tui` exports remain compatible.

---

## File structure

- Create `src/tui-dialog-interaction.ts`: pure keyboard and pointer event translation.
- Create `tests/tui-dialog-interaction.test.mjs`: regression coverage for real handler behavior.
- Modify `src/tui-dialog-view.tsx`: mounted keyboard listener and hover/click row wiring.
- Modify `src/tui.ts`: remove the temporary keymap layer and pass close ownership to the view.
- Modify `tests/tui-plugin.test.mjs`: assert the simplified lifecycle and generation behavior.
- Modify `package.json` and `package-lock.json`: release version 0.2.8.
- Modify `README.md`: document keyboard and mouse controls.

### Task 1: Interaction regression helpers

**Files:**
- Create: `src/tui-dialog-interaction.ts`
- Create: `tests/tui-dialog-interaction.test.mjs`

**Interfaces:**
- Produces: `handleLoopDialogKey(event, controller): boolean`.
- Produces: `createLoopDialogPointerHandlers(index, controller)`.
- Consumes controller methods `move`, `select`, `activate`, `activateAt`, `pageMessage`, and `close`.

- [ ] **Step 1: Write failing tests**

Add tests that import the two helpers, send `up`, `down`, `tab`, shifted `tab`, `return`, `space`, `pageup`, `pagedown`, and `q`, and assert the exact controller call plus `preventDefault`/`stopPropagation`. Add a pointer test that asserts hover and press select the row and release activates the same row.

- [ ] **Step 2: Verify RED**

Run: `npm run build && node --test tests/tui-dialog-interaction.test.mjs`

Expected: FAIL because `dist/tui-dialog-interaction.js` does not exist.

- [ ] **Step 3: Implement the minimal pure helpers**

Implement a switch over `event.name`, use `event.shift` for reverse tab, consume only recognized keys, and return pointer callbacks that close over the row index.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && node --test tests/tui-dialog-interaction.test.mjs`

Expected: all interaction tests PASS.

### Task 2: Mount input handling in the dialog

**Files:**
- Modify: `src/tui-dialog-view.tsx`
- Modify: `src/tui.ts`
- Modify: `tests/tui-plugin.test.mjs`

**Interfaces:**
- `LoopFeedbackDialogProps` gains `onClose(): void` and no longer exposes an external ref.
- The internal controller implements the interaction helper contract.

- [ ] **Step 1: Write failing plugin lifecycle assertions**

Update the plugin test to require zero temporary keymap layers after opening and to close through the view callback. Run it before production edits and confirm it fails because 0.2.7 registers a layer.

- [ ] **Step 2: Wire `useKeyboard` and pointer helpers**

Create the controller inside `LoopFeedbackDialog`, call `useKeyboard` with `handleLoopDialogKey`, use the pointer callbacks on every action row, and keep selection visibility behavior unchanged.

- [ ] **Step 3: Remove plugin-level keyboard layer state**

Delete registration, disposal, and failure cleanup for the temporary layer. Pass `onClose` to the rendered view while retaining generation checks.

- [ ] **Step 4: Verify focused and full suites**

Run: `npm run build && node --test tests/tui-dialog-interaction.test.mjs tests/tui-plugin.test.mjs`

Then run: `npm test`

Expected: all tests PASS with zero failures.

### Task 3: Release and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces npm package version `0.2.8` with unchanged exports.

- [ ] **Step 1: Document controls and bump version**

Document `Up/Down`, `Tab/Shift+Tab`, `Enter/Space`, mouse hover/click, `q`, and `Esc`. Update package metadata to 0.2.8.

- [ ] **Step 2: Verify package contents**

Run: `npm test && npm publish --dry-run`

Expected: full suite passes and dry-run contains the required dist, command, README, license, and package metadata files.

- [ ] **Step 3: Validate in local OpenCode**

Install the packed build into the actual OpenCode plugin cache without changing existing task state. Open `/loop list --all` in a separate OpenCode process and verify keyboard movement/activation, mouse hover/click, and close behavior.

- [ ] **Step 4: Commit, push, and integrate**

Review the complete diff, commit only scoped files, push `codex/fix-loop-dialog-navigation`, create a ready pull request, and merge after checks pass.

- [ ] **Step 5: Publish and revalidate**

Run authenticated `npm publish`, confirm `npm view opencode-plugin-loop version` is 0.2.8, refresh the local OpenCode cache from npm, and rerun the smoke test.
