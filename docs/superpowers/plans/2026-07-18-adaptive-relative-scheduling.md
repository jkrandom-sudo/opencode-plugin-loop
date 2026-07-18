# Adaptive Relative Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make natural-language Adaptive `/loop` commands execute immediately, convert explicit stable cadences to jitter-free Fixed tasks, and let Adaptive rescheduling use relative `delayMs` values.

**Architecture:** Extend the persisted task model and store with an atomic Adaptive-to-Fixed transition, then expose distinct `delayMs` and `set_fixed` tool contracts. The scheduler owns Jitter policy and returns a model-facing initial prompt in the command result; the command hook injects that prompt into the existing model turn instead of starting a nested request.

**Tech Stack:** TypeScript, Node.js ESM, `@opencode-ai/plugin`, Zod schemas, Node test runner, OpenCode 1.18.x.

## Global Constraints

- `delayMs` and `nextDueAtMs` are mutually exclusive; a conflict must not modify persisted state.
- Adaptive relative delays are clamped to task bounds and stored as `toolCallTime + effectiveDelayMs` without Jitter.
- `set_fixed` accepts only Adaptive tasks and finite `intervalMs >= 1000`.
- Adaptive-to-Fixed conversion defaults `jitterEnabled` to `false`.
- Existing Fixed tasks with no `jitterEnabled` field behave as `true`.
- Explicit Fixed syntax and Maintenance scheduling remain backward compatible.
- Persisted state remains version `1` and no runtime dependency is added.
- Do not push, publish npm, or merge the pull request during this plan.

---

### Task 1: Persisted Jitter Policy and Atomic Fixed Conversion

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store.ts`
- Test: `tests/store.test.mjs`

**Interfaces:**
- Consumes: existing `LoopTask`, `CreateTaskInput`, and `LoopStoreInstance`.
- Produces: optional `jitterEnabled` fields and `store.setFixed(id, intervalMs, jitterEnabled, now?)`.

- [ ] **Step 1: Write failing store tests**

Add a test that creates an Adaptive task, calls:

```js
const converted = await store.setFixed(task.id, 120_000, false, 10_000)
assert.equal(converted.mode, "fixed")
assert.equal(converted.intervalMs, 120_000)
assert.equal(converted.jitterEnabled, false)
assert.equal(converted.adaptiveMinMs, undefined)
assert.equal(converted.adaptiveMaxMs, undefined)
assert.equal(converted.lastFiredAt, 10_000)
assert.equal(converted.nextDueAt, 130_000)
```

Also test that Fixed creation persists an explicit false value and a legacy Fixed task without the field loads unchanged.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm run build && node --test tests/store.test.mjs
```

Expected: FAIL because `setFixed` does not exist and `jitterEnabled` is not persisted.

- [ ] **Step 3: Implement the minimal task/store changes**

Add `jitterEnabled?: boolean` to `LoopTask` and `CreateTaskInput`, persist it in `create()`, and add:

```ts
setFixed: async (id, intervalMs, jitterEnabled, now = Date.now()) => {
  const task = inst.get(id)
  if (!task) return null
  task.mode = "fixed"
  task.intervalMs = intervalMs
  task.jitterEnabled = jitterEnabled
  delete task.adaptiveMinMs
  delete task.adaptiveMaxMs
  task.lastFiredAt = now
  task.nextDueAt = now + intervalMs
  await inst.persist()
  return task
},
```

Expose the exact signature on `LoopStoreInstance`.

- [ ] **Step 4: Verify GREEN**

Run the focused test command and confirm zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/store.ts tests/store.test.mjs
git commit -m "feat: persist fixed task jitter policy"
```

---

### Task 2: Relative Reschedule and Fixed Conversion Tools

**Files:**
- Modify: `src/tools/loop-tools.ts`
- Test: `tests/per-session.test.mjs`

**Interfaces:**
- Consumes: `store.setFixed`, Scheduler Adaptive helpers, session scoping.
- Produces: `delayMs`, `jitterEnabled`, and action `set_fixed`.

- [ ] **Step 1: Write failing tool tests**

Add independent tests for:

1. in-range `delayMs: 2000` producing tool-call time plus 2000ms;
2. lower/upper Adaptive delay clamping;
3. simultaneous `delayMs` and `nextDueAtMs` returning `ok: false` without mutation;
4. `set_fixed` converting an owned Adaptive task with `intervalMs: 120000` and default false Jitter;
5. explicit true Jitter overriding that conversion default;
6. missing, short, and non-finite intervals plus non-Adaptive targets being rejected without mutation;
7. cross-session conversion being rejected unless `all: true`.

Use a timing window:

```js
const started = Date.now()
const result = JSON.parse(await tools.loop_schedule.execute(
  { action: "reschedule", taskId: task.id, delayMs: 2_000 },
  mockCtx(SID_A, dir)
))
assert.equal(result.requestedDelayMs, 2_000)
assert.equal(result.effectiveDelayMs, 2_000)
assert.ok(Date.parse(result.task.nextDueAt) >= started + 2_000)
assert.ok(Date.parse(result.task.nextDueAt) <= Date.now() + 2_000)
```

- [ ] **Step 2: Verify RED**

```bash
npm run build && node --test tests/per-session.test.mjs
```

Expected: FAIL because `set_fixed` and `delayMs` are absent.

- [ ] **Step 3: Extend schema and implement relative reschedule**

Add:

```ts
action: z.enum(["create", "list", "cancel", "reschedule", "set_fixed", "pause", "resume"]),
delayMs: z.number().finite().optional(),
nextDueAtMs: z.number().finite().optional(),
jitterEnabled: z.boolean().optional(),
```

Reject the conflict before any write:

```ts
if (args.delayMs !== undefined && args.nextDueAtMs !== undefined) {
  return JSON.stringify({
    ok: false,
    error: "delayMs and nextDueAtMs are mutually exclusive",
  })
}
```

Capture one `toolCallTime = Date.now()`. For Adaptive `delayMs`, clamp `toolCallTime + delayMs` through the existing Scheduler helper and report requested/effective delays plus final ISO time. Reject `delayMs` for non-Adaptive tasks. Preserve absolute-time and omitted-time behavior.

- [ ] **Step 4: Implement `set_fixed`**

Validate ID, ownership, Adaptive mode, and `intervalMs >= 1000`, then call:

```ts
const jitterEnabled = args.jitterEnabled ?? false
const converted = await store.setFixed(args.taskId, args.intervalMs, jitterEnabled)
```

Return effective mode, interval, Jitter setting, and ISO due time. Fixed tool creation persists an explicitly supplied `args.jitterEnabled`; Task 3 adds the programmatic default after `SchedulerOptions.defaultJitterEnabled` exists.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run build && node --test tests/per-session.test.mjs
git add src/tools/loop-tools.ts tests/per-session.test.mjs
git commit -m "feat: add relative and fixed scheduling tools"
```

---

### Task 3: Task-Level Jitter and Manual Configuration

**Files:**
- Modify: `src/types.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/index.ts`
- Modify: `src/tools/loop-tools.ts`
- Test: `tests/scheduler.test.mjs`
- Test: `tests/per-session.test.mjs`

**Interfaces:**
- Consumes: persisted `jitterEnabled` and `Jitter.compute()`.
- Produces: `defaultJitterEnabled` and command flags `--jitter=true|false`.

- [ ] **Step 1: Write failing scheduler tests**

Cover:

- false Jitter makes `nextDueAt()` and `rearmFixed()` exactly `now + intervalMs`;
- a missing task field retains existing Jitter;
- a false programmatic default applies to `/loop 2m task`;
- each valid command flag overrides the default and is removed from `task.prompt`;
- `--jitter=maybe` remains prompt text and does not silently alter policy;
- Fixed tool creation uses the programmatic default when `jitterEnabled` is omitted and an explicit tool value wins.

- [ ] **Step 2: Verify RED**

```bash
npm run build && node --test tests/scheduler.test.mjs tests/per-session.test.mjs
```

- [ ] **Step 3: Add configuration and scheduler policy**

Add `defaultJitterEnabled?: boolean` to both `LoopConfig` and `SchedulerOptions`. Normalize missing values with `opts.defaultJitterEnabled ?? true`, and pass the normalized true default from `src/index.ts`; this keeps existing programmatic Scheduler construction source-compatible.

In Fixed tool creation, persist `args.jitterEnabled ?? scheduler.opts.defaultJitterEnabled`.

Centralize Fixed due-time calculation:

```ts
const jitterMs = task.jitterEnabled === false
  ? 0
  : inst.opts.jitter.compute(task.id, task.intervalMs, now)
return now + task.intervalMs + jitterMs
```

Use it from `nextDueAt()`, `rearmFixed()`, resume, and post-fire scheduling.

- [ ] **Step 4: Parse command flags**

After extracting an explicit interval, remove the first exact `--jitter=true` or `--jitter=false` token from the remaining prompt. Store its boolean or the configured default. Preserve invalid flags as prompt text. If removing the valid flag leaves no prompt, return the existing empty-command error.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run build && node --test tests/scheduler.test.mjs tests/per-session.test.mjs
git add src/types.ts src/scheduler.ts src/index.ts src/tools/loop-tools.ts tests/scheduler.test.mjs tests/per-session.test.mjs
git commit -m "feat: configure jitter per fixed task"
```

---

### Task 4: Immediate Adaptive Execution and Policy Classification

**Files:**
- Modify: `src/adaptive-policy.ts`
- Modify: `src/runtime-feedback.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/index.ts`
- Test: `tests/adaptive-policy.test.mjs`
- Test: `tests/scheduler.test.mjs`
- Test: `tests/integration.test.mjs`

**Interfaces:**
- Consumes: `set_fixed`, `delayMs`, and the persisted fallback.
- Produces: `CommandParseResult.modelPrompt?` and an optional command replacement.

- [ ] **Step 1: Write failing prompt and integration tests**

Require the Adaptive Prompt to contain `set_fixed`, `intervalMs`, and `delayMs`, and stop instructing the model to calculate an absolute epoch.

Assert that a natural-language Adaptive command returns a `modelPrompt`, preserves the original request and fallback, and sets `lastFiredAt > 0` without changing `nextDueAt`.

In integration tests, verify a natural-language command replaces the current output with the initial execution/policy Prompt, while explicit Fixed, Maintenance, management, and failed commands retain the handled acknowledgement.

- [ ] **Step 2: Verify RED**

```bash
npm run build && node --test tests/adaptive-policy.test.mjs tests/scheduler.test.mjs tests/integration.test.mjs
```

- [ ] **Step 3: Update the model contract**

Revise `buildAdaptiveExecutionPrompt()` to instruct this order:

1. complete the task;
2. call `set_fixed` with `intervalMs` for explicit stable recurrence;
3. call `reschedule` with `delayMs` for result-dependent timing;
4. make no call when the fallback is suitable;
5. cancel when future work is unnecessary.

Keep task ID, bounds, fallback epoch/ISO, and the no-false-claim instruction.

- [ ] **Step 4: Return and inject the initial Prompt**

Add `modelPrompt?: string` to `CommandParseResult`. After Adaptive creation and random rearming, run:

```ts
await inst.opts.store.markFired(task.id, task.nextDueAt)
```

Return the built Prompt. Change `consumeLoopCommand` to accept an optional replacement:

```ts
export function consumeLoopCommand(
  parts: Part[],
  replacement = HANDLED_COMMAND_PROMPT
): void
```

In `command.execute.before`, call Scheduler first and then consume with `result.modelPrompt`. Do not call `client.session.prompt()` from the command hook.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npm run build && node --test tests/adaptive-policy.test.mjs tests/scheduler.test.mjs tests/integration.test.mjs
git add src/adaptive-policy.ts src/runtime-feedback.ts src/scheduler.ts src/index.ts tests/adaptive-policy.test.mjs tests/scheduler.test.mjs tests/integration.test.mjs
git commit -m "feat: classify adaptive schedule on first run"
```

---

### Task 5: Documentation and Automated Regression

**Files:**
- Modify: `README.md`
- Modify: `commands/loop.md`
- Test: all `tests/*.test.mjs`

**Interfaces:**
- Consumes: all new public behavior.
- Produces: user-facing documentation and a verified npm package preview.

- [ ] **Step 1: Update documentation**

Document immediate first execution, `delayMs`, `set_fixed`, the mutual-exclusion error, command/tool Jitter configuration, programmatic `defaultJitterEnabled`, legacy default behavior, and ticker latency. Replace the preferred absolute-time example with:

```ts
loop_schedule({
  action: "reschedule",
  taskId: "abc12345",
  delayMs: 5 * 60_000,
})
```

- [ ] **Step 2: Run full automated verification**

```bash
npm test
npm publish --dry-run
git diff --check
```

Expected: build succeeds, all tests have zero failures, package preview contains expected files, and diff check is empty.

- [ ] **Step 3: Review and commit**

Compare the diff line-by-line with the approved spec and confirm every requirement has a test.

```bash
git add README.md commands/loop.md
git commit -m "docs: explain adaptive schedule classification"
```

---

### Task 6: Real OpenCode Two-Minute Verification

**Files:**
- Runtime artifacts only under `.opencode/`, moved to timestamped `/tmp` storage after the test.
- No source files should change during host verification.

**Interfaces:**
- Consumes: the built worktree package and local OpenCode host.
- Produces: session export, persisted timing evidence, and restored npm configuration.

- [ ] **Step 1: Install the worktree build safely**

Back up effective OpenCode configs and caches to timestamped `/tmp` paths. Install the worktree plugin globally with `--force`, ensure effective config contains one worktree `file://` entry, and verify OpenCode resolves the worktree build. Preserve every replaced path for restoration.

- [ ] **Step 2: Run the scenario**

Start OpenCode with logs and execute:

```text
/loop 每隔两分钟查看opencode-plugin-loop插件最新版本
```

Verify the first model turn immediately runs `npm view opencode-plugin-loop version` and calls `set_fixed` with `intervalMs: 120000`.

- [ ] **Step 3: Verify persisted and live timing**

Confirm:

- mode is `fixed`;
- `jitterEnabled` is false;
- conversion sets `nextDueAt - lastFiredAt = 120000ms`;
- the second run begins in the inclusive window from `nextDueAt` through `nextDueAt + 5000ms`.

If the model does not classify the explicit cadence, export the session, add a failing Prompt regression test, and repeat RED/GREEN plus the full suite before retrying.

- [ ] **Step 4: Clean up and restore**

Cancel the test task, exit OpenCode, move generated artifacts to timestamped `/tmp`, restore the unversioned npm entry `opencode-plugin-loop`, and verify cached npm remains version `0.2.10` unless publishing is separately authorized.

- [ ] **Step 5: Final freshness checks**

```bash
npm test
git status --short
git log --oneline -8
```

Expected: all tests pass, no generated runtime artifacts remain, and only intentional commits exist.
