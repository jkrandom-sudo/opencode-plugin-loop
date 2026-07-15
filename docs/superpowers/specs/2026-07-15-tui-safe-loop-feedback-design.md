# TUI-safe `/loop` feedback design

## Problem

`opencode-plugin-loop` writes command results and runtime warnings with
`console.log()` and `console.warn()`. OpenCode owns the terminal and redraws its
TUI asynchronously, so direct writes bypass the renderer and leave persistent
task-list text over the prompt area.

The `command.execute.before` hook handles `/loop` as a side effect but leaves the
expanded command parts unchanged. OpenCode therefore also sends arguments such
as `list` or `stop-all` to the model as an ordinary prompt, which can trigger an
unrelated model response or tool call.

## Goals

- Never write plugin runtime output directly to stdout or stderr.
- Keep `/loop` command results visible without corrupting the input area.
- Prevent already-handled `/loop` arguments from becoming an ordinary model task.
- Preserve task scheduling, session scoping, persistence, and public tool APIs.
- Publish the fix as version `0.2.4` to GitHub and npm.

## Design

### Structured runtime logging

Add a small logger adapter backed by `ctx.client.app.log()`. Ticker failures and
session-cleanup diagnostics use this adapter with an explicit service name and
severity. No plugin runtime path may call `console.log()`, `console.warn()`, or
`console.error()`.

The adapter accepts unknown error values and records a stable string plus useful
metadata. A logging failure must not break scheduling or command execution.

### TUI feedback

After `scheduler.handleUserCommand()` returns, show the result through
`ctx.client.tui.showToast()`. Successful operations use the `success` variant,
invalid commands and failed operations use `error`, and informational list or
status responses use `info`. Toast duration scales up for multiline task lists,
with a bounded maximum.

If the TUI endpoint is unavailable, command handling still succeeds and the
result remains available in structured logs.

### Consume the model-facing command body

The command hook rewrites text parts in `output.parts` after handling `/loop`.
The replacement states that the plugin has already completed the command and
instructs the model to acknowledge it briefly without tools or additional work.
Non-text metadata is preserved.

This is the safest behavior available in the current OpenCode server-plugin API:
the hook can transform command parts but cannot cancel prompt submission. It
prevents arguments such as `list` from being interpreted as standalone user
instructions while keeping the command lifecycle valid.

### Packaging and installation guidance

Bump the package to `0.2.4`, rebuild committed `dist` files, and add a README
troubleshooting note explaining that users must not keep both the npm plugin and
a copied global plugin directory. OpenCode loads both sources independently.

## Error handling

- Scheduler command errors are converted to an error toast and structured log.
- Failure to display a toast is logged and does not undo a completed command.
- Failure to write a structured log is swallowed to avoid recursive terminal
  logging and to keep the scheduler alive.
- Existing ticker isolation and in-flight task protection remain unchanged.

## Tests

- A command-hook regression test asserts that `/loop list` emits no console
  output, calls the TUI toast endpoint, and replaces the model-facing text.
- A runtime logging test asserts that ticker or cleanup diagnostics use
  `client.app.log()` rather than console methods.
- Existing scheduler, persistence, jitter, session, and integration tests remain
  green.
- TypeScript build and `npm publish --dry-run` must succeed.
- A real OpenCode PTY run must show that `/loop list` does not leave raw task
  lines in the prompt area and does not make the model perform a directory list.

## Release

Commit the implementation, push `main` and tag `v0.2.4` to
`jkrandom-sudo/opencode-plugin-loop`, then publish `opencode-plugin-loop@0.2.4`
with npm. Verify both remote version surfaces after publication.
