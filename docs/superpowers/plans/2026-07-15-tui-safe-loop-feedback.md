# TUI-safe Loop Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `/loop` output from corrupting the OpenCode TUI, prevent command arguments from becoming standalone model tasks, and publish `0.2.4`.

**Architecture:** Add a focused runtime-feedback module that owns structured logging, toast rendering, error normalization, and model-facing command-part replacement. Inject its logger into the persistent store and use it from plugin lifecycle hooks, leaving scheduler behavior and public tools unchanged.

**Tech Stack:** TypeScript ES modules, `@opencode-ai/plugin`, Node.js built-in test runner, npm, OpenCode 1.17.18 PTY.

## Global Constraints

- Never write plugin runtime output directly to stdout or stderr.
- Keep `/loop` command results visible through the OpenCode TUI.
- Prevent already-handled `/loop` arguments from becoming ordinary model tasks.
- Preserve task scheduling, session scoping, persistence, and public tool APIs.
- Publish exactly version `0.2.4` to GitHub and npm.

---

### Task 1: Runtime feedback and command consumption

**Files:**
- Create: `src/runtime-feedback.ts`
- Modify: `src/index.ts`
- Modify: `tests/integration.test.mjs`

**Interfaces:**
- Produces: `LoopLogger(level, message, extra?) => Promise<void>`.
- Produces: `createLoopLogger(client)`, `showLoopResult(client, result, logger)`, `consumeLoopCommand(parts)`.
- Consumes: OpenCode `client.app.log`, `client.tui.showToast`, and hook `output.parts`.

- [ ] **Step 1: Write failing command-hook regression tests**

Add tests that build a mock client with `app.log` and `tui.showToast` spies, call
`command.execute.before` with `/loop list`, and assert:

```js
assert.equal(consoleCalls.length, 0)
assert.equal(toastCalls.length, 1)
assert.equal(toastCalls[0].body.variant, "info")
assert.match(toastCalls[0].body.message, /loop task/)
assert.doesNotMatch(output.parts[0].text, /^list$/)
assert.match(output.parts[0].text, /already handled/)
```

Add a second test whose store is full so task creation throws, then assert an
`error` toast is emitted and the hook resolves rather than rejecting.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run build && node --test --test-name-pattern='TUI-safe|command failure' tests/integration.test.mjs`

Expected: FAIL because no toast is emitted and the original model-facing text is unchanged.

- [ ] **Step 3: Implement the runtime-feedback module**

Create these focused exports:

```ts
import type { PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import type { CommandParseResult } from "./scheduler.js"

export type LoopLogLevel = "debug" | "info" | "warn" | "error"
export type LoopLogger = (
  level: LoopLogLevel,
  message: string,
  extra?: Record<string, unknown>
) => Promise<void>

export function createLoopLogger(client: PluginInput["client"]): LoopLogger
export function consumeLoopCommand(parts: Part[]): void
export async function showLoopResult(
  client: PluginInput["client"],
  result: CommandParseResult,
  logger: LoopLogger
): Promise<void>
export function errorMessage(error: unknown): string
```

`createLoopLogger` calls `client.app.log({ body: { service:
"opencode-plugin-loop", level, message, extra } })` inside a no-throw boundary.
`showLoopResult` selects `error` for messages beginning with `❌`, `info` for
task lists, and `success` otherwise; it calls `client.tui.showToast` with a
5–12 second bounded duration. `consumeLoopCommand` replaces the first text part
with a fixed acknowledgement-only instruction and marks subsequent text parts
ignored, preserving all non-text parts.

- [ ] **Step 4: Wire feedback into the command hook**

Create the logger once in `LoopPlugin`. In `command.execute.before`, always call
`consumeLoopCommand(output.parts)`, convert scheduler exceptions to
`{ message: "❌ /loop failed: ..." }`, log the result, then call
`showLoopResult`. Replace ticker and session cleanup console calls with the
logger.

- [ ] **Step 5: Build and verify GREEN**

Run: `npm run build && node --test --test-name-pattern='TUI-safe|command failure' tests/integration.test.mjs`

Expected: PASS with zero failing tests and no console output.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/runtime-feedback.ts src/index.ts tests/integration.test.mjs dist
git commit -m "fix: render loop feedback through OpenCode TUI"
```

### Task 2: Remove persistent-store console writes

**Files:**
- Modify: `src/store.ts`
- Modify: `src/index.ts`
- Modify: `tests/store.test.mjs`

**Interfaces:**
- Consumes: `LoopLogger` from `src/runtime-feedback.ts`.
- Extends: `LoopStoreOptions` with optional `logger?: LoopLogger`.
- Preserves: existing factory-call and constructor-call compatibility.

- [ ] **Step 1: Write failing store logging tests**

Add one test that loads a state file containing an expired/orphaned task and
asserts the injected logger receives an `info` cleanup message. Add another that
loads malformed JSON and asserts an `error` or `warn` structured message is
received. Temporarily spy on all console methods and assert none are called.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm run build && node --test --test-name-pattern='structured logger' tests/store.test.mjs`

Expected: FAIL because `LoopStoreOptions.logger` is not used and current code writes to console.

- [ ] **Step 3: Inject the logger into LoopStore**

Add `logger?: LoopLogger` to `LoopStoreOptions`, capture a no-op fallback, and
replace all three console sites in `load()` and `logFire()` with awaited logger
calls. Pass the plugin logger from `src/index.ts` when constructing the store.

- [ ] **Step 4: Verify store tests and static console audit**

Run: `npm run build && node --test --test-name-pattern='structured logger' tests/store.test.mjs`

Run: `rg -n 'console\.(log|warn|error)' src`

Expected: tests PASS; `rg` exits 1 with no matches.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/store.ts src/index.ts tests/store.test.mjs dist
git commit -m "fix: route loop runtime diagnostics to app log"
```

### Task 3: Documentation, package version, and release artifacts

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `dist/**`

**Interfaces:**
- Produces: npm package `opencode-plugin-loop@0.2.4`.

- [ ] **Step 1: Add duplicate-install troubleshooting guidance**

Document that npm configuration and `~/.config/opencode/plugins/opencode-plugin-loop`
are loaded independently, so users should keep one installation source. Include
commands to remove the copied directory only after verifying npm configuration.

- [ ] **Step 2: Bump version without creating a tag**

Run: `npm version 0.2.4 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` both report `0.2.4`.

- [ ] **Step 3: Build committed distribution files**

Run: `npm run build`

Expected: exit 0 and `dist/runtime-feedback.js` plus declarations are generated.

- [ ] **Step 4: Run full automated verification**

Run: `npm test`

Run: `npm run build`

Run: `npm publish --dry-run`

Expected: all tests pass, TypeScript exits 0, and dry-run lists only intended package files for version `0.2.4`.

- [ ] **Step 5: Commit Task 3**

```bash
git add README.md package.json package-lock.json dist
git commit -m "chore: prepare 0.2.4 release"
```

### Task 4: Real OpenCode regression and remote release

**Files:**
- Verify: local OpenCode configuration and PTY output.
- Modify externally: GitHub `main`, Git tag `v0.2.4`, npm package registry.

**Interfaces:**
- Consumes: OpenCode 1.17.18, GitHub credentials, npm publication credentials.
- Produces: GitHub and npm release surfaces at `0.2.4`.

- [ ] **Step 1: Install the built package in an isolated OpenCode plugin configuration**

Use a temporary OpenCode config/data directory that references the local package
and contains one test task. Do not delete or alter the user's existing saved
tasks.

- [ ] **Step 2: Run a PTY regression**

Launch OpenCode, execute `/loop list`, and inspect the captured terminal stream.
Verify there is a TUI toast, no raw `[task-id] active` text outside renderer
frames, and no model tool call interpreting `list` as a directory-list request.

- [ ] **Step 3: Re-run the final verification gate**

Run: `npm test && npm run build && npm publish --dry-run && git diff --check`

Expected: all commands exit 0 immediately before release.

- [ ] **Step 4: Review the complete diff and commit range**

Compare against `5e77871` (current `origin/main`) and confirm only the already
prepared `0.2.3` release plus this design, plan, fix, tests, docs, and `0.2.4`
release artifacts are included.

- [ ] **Step 5: Push GitHub main and tag**

```bash
git push origin main
git tag -a v0.2.4 -m "0.2.4"
git push origin v0.2.4
```

Expected: both pushes succeed without force.

- [ ] **Step 6: Publish npm and verify registry state**

Run `npm publish` using a temporary user config containing the provided token,
then remove that temporary config. Do not persist the token in the repository or
the user's default npm configuration.

Run: `npm view opencode-plugin-loop version dist-tags.latest --json`

Expected: both fields report `0.2.4`.
