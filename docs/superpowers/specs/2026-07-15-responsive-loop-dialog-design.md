# Responsive Loop dialog design

## Context

Version 0.2.5 moved `/loop` feedback out of raw terminal output and into an OpenCode `DialogSelect`. That fixes prompt corruption, but it places the complete Loop message inside the select component's title. OpenCode constrains the option list height, not the wrapped title height. A long message can therefore consume most or all of a short terminal and push the actions outside the visible area.

The current copy actions also leave the dialog open after a successful clipboard write. The requested behavior is to close immediately after `Copy ID` or `Copy all` succeeds.

## Goals

- Keep the complete Loop result available inside the dialog.
- Make the dialog respond to terminal width and height changes without overflowing the viewport.
- Keep every action reachable in short or narrow terminals.
- Close the current dialog immediately after a successful copy.
- Keep the dialog open after a clipboard failure so the user can retry or close it.
- Preserve keyboard, mouse, replacement, cleanup, and structured-error behavior from 0.2.5.

## Non-goals

- Scaling terminal font size. Terminal UIs render in character cells and cannot resize the user's font.
- Replacing OpenCode's native dialog stack or backdrop.
- Changing scheduler behavior, task persistence, or `/loop` command syntax.
- Truncating the value copied by `Copy all`.

## Chosen approach

Render a custom OpenCode TUI JSX component inside the native `api.ui.dialog` stack. The component uses the supported `@opentui/solid` and `@opentui/core` primitives, while OpenCode continues to own modal focus, backdrop behavior, `Esc`, theme integration, and dialog replacement.

The alternatives were rejected for these reasons:

- Keeping `DialogSelect` would still leave the full message in a non-scrollable title, so it cannot satisfy the small-window requirement without truncation.
- A plugin-owned full-screen overlay would allow arbitrary percentages but would duplicate OpenCode's modal focus and dialog lifecycle, increasing compatibility risk.

## Layout

The host dialog remains `medium`. OpenCode therefore uses a nominal width of 60 columns and clamps it to the terminal width minus two columns. This makes the width shrink automatically in narrow windows while retaining the native margins and backdrop.

The custom content calculates its maximum height from live terminal dimensions:

1. Start with 70% of the terminal row count.
2. Cap the result at 28 rows for large terminals.
3. Clamp it to the rows available inside OpenCode's dialog margins.
4. On extremely short terminals, use all available rows instead of enforcing a minimum that could overflow.

The component contains three regions:

1. A fixed header with the variant icon, `Loop`, and an `esc` hint.
2. A scrollable message viewport containing the exact Loop result.
3. A bottom action viewport containing one `Copy ID` action per distinct ID, followed by `Copy all` and `Close`.

The action viewport shows at least the selected row whenever any row can be displayed. With many task IDs it scrolls independently instead of expanding the dialog. The message viewport receives the remaining height. On extremely short terminals, actions take priority and the message remains available through a one-row scroll viewport and `Copy all`.

Terminal resize signals cause the height allocation to recompute without closing or recreating the dialog.

## Interaction model

- `Up` and `Down` move through actions and keep the selected action visible.
- `Enter` and `Space` activate the selected action.
- Mouse click selects and activates an action.
- Mouse wheel scrolls the region under the pointer.
- `PageUp` and `PageDown` scroll the message viewport.
- `q` and OpenCode's native `Esc` close the dialog.
- A new Loop result replaces the old dialog and resets selection to the first action.

Copy behavior is transactional:

1. Ignore repeated activation while the selected copy is in progress.
2. Await the clipboard write.
3. On success, show the existing success toast and close the dialog only if it is still the same dialog generation.
4. On failure, show the existing error toast and keep that dialog open.

The generation check prevents a slow clipboard operation from closing a newer Loop result that replaced the original dialog.

## Component boundaries

### Feedback model

`src/tui-feedback-model.ts` continues to own exact message preservation, task ID extraction, deduplication, and toast ownership checks.

### Dialog controller

A small controller owns the ordered actions, selected index, copy-in-progress guard, generation identity, and action execution. It contains no JSX so selection and async copy behavior can be tested independently.

### Dialog view

The TUI JSX view owns responsive row allocation, theme-aware rendering, two scroll viewports, selected-row visibility, and mouse/keyboard presentation. It delegates actions to the controller.

### Plugin lifecycle

`src/tui.tsx` continues to subscribe to `tui.toast.show`, replace owned dialogs, register the temporary keymap layer, clean up on close/disposal, and write structured diagnostics for render or registration failures.

## Dependencies and packaging

- Compile the TUI entrypoint as TSX with `@opentui/solid` as the JSX import source.
- Add compatible OpenTUI packages as development dependencies for compilation and peer dependencies for the OpenCode host runtime, following the OpenCode 1.17.18 TUI plugin contract.
- Keep the server entrypoint free of OpenTUI and clipboard imports.
- Preserve the published root, `./server`, and `./tui` entrypoints.

## Error handling

- Clipboard failure keeps the current dialog open and produces an error toast.
- Dialog construction, keymap registration, or cleanup failures cannot escape the event handler.
- Partial ownership is cleared and the temporary keymap layer is released after an opening failure.
- Structured warnings use `api.client.app.log`; no direct terminal output is introduced.
- Disposal clears only the dialog generation owned by this plugin.

## Testing

Automated tests cover:

- successful `Copy ID` closes the current dialog after writing the exact ID;
- successful `Copy all` closes after writing the exact complete message;
- clipboard failure leaves the dialog open;
- a slow copy from an old generation cannot close its replacement;
- duplicate activation is ignored while copying;
- action ordering and selection wrapping;
- responsive height allocation for normal, short, and extremely short terminals;
- long messages and up to 50 task IDs remain reachable through independent scrolling;
- keyboard, mouse, `q`, and native close cleanup;
- existing render/keymap failure recovery and the full server regression suite.

Manual verification uses OpenCode 1.17.18 in both a normal PTY and a deliberately narrow/short PTY. It confirms dynamic resize, message scrolling, action scrolling, exact clipboard values, automatic close on success, and no content written over the prompt.
