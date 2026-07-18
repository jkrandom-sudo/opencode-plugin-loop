# Adaptive Reschedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Adaptive tasks a random fallback schedule and a model-facing decision protocol while guaranteeing that a successful `loop_schedule(action="reschedule")` call remains authoritative.

**Architecture:** A new pure Adaptive policy module owns bound normalization, random delay selection, absolute-time clamping, and prompt construction. The Scheduler pre-arms Adaptive tasks before prompt injection, then performs no later Adaptive scheduling write, so model tool calls override the fallback without relying on OpenCode prompt completion timing.

**Tech Stack:** TypeScript ESM, OpenCode plugin APIs, Zod tools, Node.js test runner, JSON task store.

## Global Constraints

- Adaptive fallback delays must be inside the task's inclusive `adaptiveMinMs` to `adaptiveMaxMs` range.
- Production randomness uses `Math.random`; tests inject deterministic random sources.
- A successful Adaptive `reschedule` must never be overwritten after model execution.
- Fixed and Maintenance scheduling semantics must remain unchanged.
- Existing persisted task schema version stays at `1`.
- No new runtime dependency or public entrypoint is added.
- Do not commit implementation changes, push, or publish before the user reviews local OpenCode verification results.

---

### Task 1: Pure Adaptive policy

**Files:**
- Create: `src/adaptive-policy.ts`
- Create: `tests/adaptive-policy.test.mjs`

**Interfaces:**
- Produces: `adaptiveBounds(task, defaults)`, `randomAdaptiveNextDueAt(task, defaults, random, now)`, `clampAdaptiveNextDueAt(task, defaults, requestedAt, now)`, and `buildAdaptiveExecutionPrompt(task)`.
- Consumes: `LoopTask` and Scheduler default minimum/maximum values.

- [ ] **Step 1: Write failing policy tests**

Cover random source values `0`, `0.5`, and `0.999999`; reversed bounds; below/above-bound absolute times; prompt inclusion of the original request, task ID, bounds, persisted fallback epoch/ISO value, `reschedule`, and `cancel` guidance.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm run build && node --test tests/adaptive-policy.test.mjs
```

Expected: failure because `dist/adaptive-policy.js` does not exist.

- [ ] **Step 3: Implement the minimal pure policy**

Use normalized finite integer millisecond bounds. Clamp the random source into `[0, 1)` and calculate an inclusive integer offset:

```ts
const delay = minMs + Math.floor(unit * (maxMs - minMs + 1))
```

Build a wrapper that preserves the exact user prompt and states that the model must finish the work before deciding whether to keep the fallback, reschedule, or cancel.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command and expect all Adaptive policy tests to pass.

### Task 2: Random fallback on Adaptive creation

**Files:**
- Modify: `src/scheduler.ts`
- Modify: `src/tools/loop-tools.ts`
- Modify: `tests/scheduler.test.mjs`
- Modify: `tests/per-session.test.mjs`

**Interfaces:**
- Scheduler consumes an optional `random?: () => number` dependency.
- Scheduler produces `rearmAdaptive(task, now?)` and uses the policy helper for task-specific bounds.
- `loop_schedule(create)` calls `scheduler.rearmAdaptive()` for Adaptive tasks.

- [ ] **Step 1: Write failing creation tests**

Assert `/loop <prompt>` and `loop_schedule(action="create", mode="adaptive")` persist midpoint fallback times when the injected random source returns `0.5`.

- [ ] **Step 2: Verify RED**

Run the two focused test files and confirm existing behavior still chooses `adaptiveMaxMs`.

- [ ] **Step 3: Implement minimal Scheduler and Tool changes**

Store the random dependency in Scheduler options, add `rearmAdaptive`, and call it immediately after Adaptive task creation. Do not change Fixed or Maintenance creation.

- [ ] **Step 4: Verify GREEN**

Run focused Scheduler and per-session tests and expect them to pass.

### Task 3: Pre-arm before model execution

**Files:**
- Modify: `src/scheduler.ts`
- Modify: `src/index.ts`
- Modify: `tests/integration.test.mjs`
- Modify: `tests/per-session.test.mjs`

**Interfaces:**
- Scheduler produces `executeTask(task, ctx, now?)`.
- The ticker delegates fire/reschedule ordering to `executeTask`.
- Adaptive execution pre-arms and wraps the prompt; Fixed and Maintenance retain post-fire scheduling.

- [ ] **Step 1: Write failing ordering tests**

Use a fake `client.session.prompt` that inspects the store before returning and then calls `store.reschedule`. Assert:

```text
fallback persisted before prompt callback
model reschedule value remains after executeTask returns
no model reschedule leaves fallback unchanged
```

Also assert Fixed scheduling still happens after prompt execution.

- [ ] **Step 2: Verify RED**

Run the focused integration and per-session tests. Expect failure because the ticker currently writes `markFired` after `fireTask`.

- [ ] **Step 3: Implement execution orchestration**

For Adaptive tasks:

```ts
await scheduler.rearmAdaptive(task, now, true)
await scheduler.fireTask(task, ctx)
```

The pre-arm path must update `lastFiredAt` and `nextDueAt` through `store.markFired`. `fireTask` must inject `buildAdaptiveExecutionPrompt(task)` after the stored task reflects the fallback.

For other modes, retain:

```ts
await scheduler.fireTask(task, ctx)
await store.markFired(task.id, await scheduler.nextDueAt(task))
```

- [ ] **Step 4: Verify GREEN**

Run focused tests and verify the model override remains authoritative.

### Task 4: Adaptive Tool bound enforcement

**Files:**
- Modify: `src/tools/loop-tools.ts`
- Modify: `tests/integration.test.mjs`
- Modify: `tests/per-session.test.mjs`

**Interfaces:**
- Adaptive `reschedule` consumes task-specific bounds and Scheduler defaults.
- Its JSON result exposes `requestedNextDueAt` when provided and the final `nextDueAt`.
- Fixed and Maintenance rescheduling keeps existing unrestricted absolute-time behavior.

- [ ] **Step 1: Write failing Tool tests**

Test values below the minimum, inside the range, above the maximum, and omitted. Assert the effective persisted time and returned JSON.

- [ ] **Step 2: Verify RED**

Run focused tests and confirm the current Tool accepts out-of-range times unchanged.

- [ ] **Step 3: Implement Adaptive-only clamping**

Use tool-call `Date.now()` as the range origin. When `nextDueAtMs` is omitted, call the Scheduler Adaptive random helper. Do not clamp Fixed or Maintenance tasks.

- [ ] **Step 4: Verify GREEN**

Run focused tests and confirm all four Adaptive cases plus compatibility cases pass.

### Task 5: Documentation and full verification

**Files:**
- Modify: `README.md`
- Modify: `src/types.ts`

**Interfaces:**
- Documents the actual 5-second ticker and Adaptive fallback/override contract.

- [ ] **Step 1: Update documentation**

Replace stale 15-second default statements with 5 seconds, explain random fallback scheduling, model override behavior, cancellation semantics, and the task-specific bound enforcement.

- [ ] **Step 2: Run static checks**

```bash
rg -n "15s|15_000|tickerIntervalMs" README.md src
git diff --check
```

Expected: no stale default claim; no whitespace errors.

- [ ] **Step 3: Run complete verification**

```bash
npm test
npm pack --dry-run --json
```

Expected: all existing and new tests pass; the npm package contains server/TUI entrypoints and the new policy module.

### Task 6: Real OpenCode host verification

**Files:**
- No source files beyond the preceding tasks.
- Runtime evidence: project `.opencode/cache/loop/tasks.json` and OpenCode structured log/history.

**Interfaces:**
- Uses the local file-plugin installer and the installed OpenCode CLI/TUI.

- [ ] **Step 1: Inspect the installed OpenCode version and current plugin entries**

Record the OpenCode version and existing `opencode.json` / `tui.json` plugin values without exposing unrelated configuration secrets.

- [ ] **Step 2: Build and install the worktree**

```bash
npm run build
opencode plugin "file:///Users/wangshuai/Projects/opencode-loop/.worktrees/responsive-loop-dialog" --global --force
```

Remove only stale `opencode-plugin-loop` package cache entries that are confirmed to belong to earlier versions; preserve unrelated caches.

- [ ] **Step 3: Start OpenCode and create an Adaptive task**

Use a short test configuration for Adaptive bounds, run an Adaptive `/loop` prompt that asks the model to inspect a deterministic result, and observe the injected scheduling instructions.

- [ ] **Step 4: Verify fallback and override behavior**

Confirm from `tasks.json` and host output that:

- the initial and next fallback times are inside the configured range;
- the fallback exists before the model executes;
- a successful model `reschedule` changes `nextDueAt`;
- no post-run write restores the fallback;
- the dialog remains keyboard/mouse accessible.

- [ ] **Step 5: Restore normal local configuration**

Remove test tasks and restore any temporary Adaptive bounds. Keep the local file plugin installed only if it replaces the pre-existing plugin entry cleanly.

- [ ] **Step 6: Report without committing or publishing**

Provide test counts, observed timestamps, model scheduling decision, dialog behavior, modified files, and remaining risks. Leave implementation changes uncommitted for user review.
