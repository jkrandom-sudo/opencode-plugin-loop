# Interactive Loop Feedback Design

## Context

Version 0.2.4 routes `/loop` command feedback through OpenCode's native
`client.tui.showToast()` endpoint. This prevents direct terminal writes from
corrupting the prompt area, but the server-side toast API only supports a
title, message, variant, and duration. It cannot render buttons or receive
user actions.

OpenCode 1.17.18 can load two entrypoints from one npm package: `./server` for
runtime hooks and `./tui` for interactive terminal UI. The existing server
entrypoint must remain responsible for scheduling, persistence, tools, and
session scoping. A new TUI companion will own the interactive feedback layer.

## Goals

- Replace Loop feedback with an interactive native dialog when the TUI
  companion is active.
- Show the complete feedback text without writing below the prompt.
- Provide a `Copy all` action that copies the complete dialog content.
- Render one `Copy ID` action for every task ID present in the feedback.
- Provide an explicit `Close` action.
- Support both mouse and keyboard operation.
- Preserve the current server plugin behavior and fall back to the 0.2.4 toast
  when the TUI companion is unavailable or disabled.
- Release the feature as `opencode-plugin-loop@0.2.5`.

## Non-goals

- Changing task scheduling, persistence, jitter, or session ownership.
- Adding bulk `Copy all IDs` behavior.
- Adding buttons to OpenCode's built-in toast component, whose public API has
  no action callback surface.
- Replacing OpenCode's global clipboard or dialog implementation.

## Package Architecture

The npm package will expose explicit entrypoints:

- `./server`: the current `PluginModule` containing `LoopPlugin`.
- `./tui`: a new `TuiPluginModule` containing the interactive companion.

The package root remains compatible with existing server-plugin consumers.
`opencode plugin opencode-plugin-loop@0.2.5 --global --force` detects both
entrypoints and registers the package in the server and TUI configuration
files. Users who only retain the server registration continue to receive the
ordinary toast fallback.

The server and TUI modules remain independent. The server does not import
OpenTUI JSX code, so headless OpenCode runs do not load terminal UI
dependencies.

## Feedback Transport

The server continues to call `client.tui.showToast()` after it handles a
`/loop` command. Loop feedback uses a stable plugin-owned title so the TUI
companion can identify the corresponding `tui.toast.show` event. Other toasts
are ignored.

When the companion observes Loop feedback, it opens or replaces the current
Loop dialog with the event's complete message and variant. The underlying
toast remains the compatibility channel and expires normally. Replacing the
dialog prevents repeated commands from stacking multiple Loop windows.

Copy-result notifications use a different title and are therefore never
interpreted as new Loop feedback.

## Dialog Layout and Actions

The dialog contains three areas:

1. A `Loop` title and variant-aware status treatment.
2. The complete, selectable feedback message.
3. An action area containing task-specific actions followed by global actions.

Each distinct task ID extracted from the feedback is shown once with its own
`Copy ID` button. Multiple tasks therefore produce multiple independently
actionable rows. The global action area contains `Copy all` and `Close`.

Mouse interaction invokes the selected button directly. Keyboard navigation
uses `Tab`, `Shift+Tab`, and the arrow keys to move focus, `Enter` or `Space`
to activate the focused action, and `Escape` or `Q` to close the dialog.
Closing the dialog does not cancel, pause, or otherwise mutate any loop task.

## Task ID Extraction

A focused, pure parser extracts IDs from the canonical server messages:

- creation messages such as `[id=abc123]`;
- list rows such as `[abc123]` at the start of a task record.

The parser preserves display order, removes duplicates, and rejects tokens
that do not match the plugin's task-ID character set. Extraction failure never
blocks the dialog: the full message and global actions remain available, while
no task-specific `Copy ID` button is shown.

## Clipboard Behavior

`Copy all` writes the exact complete feedback message to the system clipboard.
Each `Copy ID` action writes only its associated raw task ID, without brackets,
labels, or whitespace.

Clipboard access is isolated behind a small adapter so it can be tested without
changing the real clipboard. The runtime implementation uses a cross-platform
clipboard library and reports success or failure through a short native toast.
A clipboard failure leaves the dialog open so the user can retry or select the
text manually.

## Error Handling and Fallbacks

- If the TUI entrypoint is absent, disabled, incompatible, or fails to load,
  the server toast remains visible and scheduling continues normally.
- If a dialog render action fails, the event handler records a structured
  diagnostic without writing to stdout or stderr.
- If clipboard writing fails, show an error toast and keep the dialog open.
- If feedback contains no task IDs, render only `Copy all` and `Close`.
- If new Loop feedback arrives while a Loop dialog is open, replace the
  content and actions with the newest feedback.
- The companion unregisters event handlers and keymap layers during disposal.

## Testing

Automated tests must cover:

- extraction of one creation-message task ID;
- extraction of multiple list-row IDs in display order;
- duplicate removal and rejection of malformed IDs;
- `Copy all` writing the exact full message;
- each task row copying only its own ID;
- explicit close behavior;
- keyboard focus and activation mapping;
- clipboard success and failure notifications;
- replacement rather than stacking for consecutive Loop events;
- ignoring non-Loop toast events;
- server-only fallback remaining functional;
- package exports resolving both `./server` and `./tui`;
- all existing 82 server tests remaining green.

Release verification must also include TypeScript builds for both entrypoints,
`npm publish --dry-run`, a clean install of 0.2.5, and a real OpenCode 1.17.18
PTY run that exercises `Copy ID`, `Copy all`, and `Close` without leaving raw
task text below the prompt.

## Release and Local Upgrade

After verification, merge the implementation to `main`, tag `v0.2.5`, push
GitHub, and publish `opencode-plugin-loop@0.2.5` with npm. Reinstall the package
globally with `--force` so OpenCode registers both entrypoints. Preserve the
existing 0.2.0 backup and verify the installed package version and real TUI
behavior before declaring completion.
