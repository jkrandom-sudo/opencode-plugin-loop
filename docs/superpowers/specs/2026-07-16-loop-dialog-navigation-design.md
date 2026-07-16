# Loop dialog navigation design

## Context

The 0.2.7 Loop dialog renders the actions correctly, but its interaction wiring does not follow the lifecycle used by OpenCode's own modal components. Keyboard navigation is registered in a plugin-level keymap layer and is only tested by invoking command callbacks directly. Mouse rows react to press and release but not hover. As a result, real terminal input can remain with the host prompt/modal stack, and moving the pointer over another row does not change the selected action.

## Goals

- Let users select `Copy ID`, `Copy all`, and `Close` with `Up`, `Down`, `Tab`, or `Shift+Tab`.
- Activate the selected action with `Enter` or `Space`.
- Select rows on mouse hover or press and activate the clicked row on release.
- Preserve `PageUp`, `PageDown`, `q`, native `Esc`, responsive layout, copy-close behavior, and generation-safe cleanup.
- Add regression tests that exercise the same handlers used by the rendered component.

## Non-goals

- Changing scheduler, task storage, or `/loop` syntax.
- Replacing the responsive custom dialog with `DialogSelect`.
- Changing clipboard contents or copy notifications.
- Stopping or editing existing Loop tasks on the user's machine.

## Chosen approach

Move keyboard ownership into the mounted `LoopFeedbackDialog` by using `useKeyboard`, matching OpenCode 1.17.18's native dialog components. The listener exists only while the dialog component is mounted and consumes recognized navigation/activation events before they reach the prompt. Remove the separate plugin-level keymap layer and its lifecycle state.

Expose small pure interaction helpers used by the component:

- `handleLoopDialogKey` maps terminal key events to move, activate, page, and close controller operations.
- `createLoopDialogPointerHandlers` maps hover, press, and release to selection and activation.

This provides deterministic Node tests without requiring OpenTUI's native test renderer, which is unavailable under the repository's Node runtime on this machine.

## Interaction details

- `Up` moves to the previous action and wraps.
- `Down` moves to the next action and wraps.
- `Tab` moves forward; `Shift+Tab` moves backward.
- `Enter`/`Return` and `Space` activate the selected action.
- `PageUp`/`PageDown` scroll the message viewport.
- `q` requests dialog close; OpenCode continues to own `Esc`.
- Mouse hover and mouse-down select the row under the pointer.
- Mouse-up activates that exact row, so a stale keyboard selection cannot trigger a different action.
- Recognized keyboard events call `preventDefault` and `stopPropagation`.

## Lifecycle and error handling

The plugin continues to own a single dialog generation. Clipboard completion closes only the generation that initiated it. Replacing or disposing a dialog destroys the component listener automatically. Clipboard failures leave the dialog open. Dialog rendering failures are logged structurally and do not leak owned state.

## Testing and release

Automated tests will first fail against 0.2.7 for the missing key and pointer helpers. They will then cover all key mappings, event consumption, exact-row pointer activation, plugin cleanup without a temporary keymap layer, clipboard behavior, and the full existing suite.

Manual validation will install the packed build into OpenCode's actual plugin cache, open `/loop list --all`, and verify keyboard selection, mouse selection/click, copy-close, and `Close`. After GitHub integration, publish npm version 0.2.8, update the local cache from the published package, and repeat the OpenCode smoke test.
