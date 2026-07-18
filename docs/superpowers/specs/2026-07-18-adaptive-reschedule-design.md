# Adaptive Reschedule Design

## Goal

Improve Adaptive mode so each task has a random fallback execution time inside its configured minimum and maximum interval, while allowing the model to replace that fallback by calling `loop_schedule(action="reschedule")` after evaluating the user's request and the current execution result.

## Confirmed Semantics

- An Adaptive task always has a persisted fallback `nextDueAt`.
- The fallback delay is a uniform random millisecond value in the task's inclusive `adaptiveMinMs` to `adaptiveMaxMs` range.
- The model calls `reschedule` only when the observed result justifies a better execution time.
- If the fallback time is appropriate, the model does not call `reschedule` and the fallback remains effective.
- If no future execution is needed, the model calls `cancel`.
- A successful model `reschedule` is authoritative and must not be overwritten after the model run finishes.
- Fixed and Maintenance scheduling behavior remains unchanged.

## Recommended Architecture

### Adaptive policy module

Create `src/adaptive-policy.ts` as a small pure module responsible for:

- normalizing Adaptive bounds;
- choosing a random delay through an injected `() => number` source;
- clamping a requested absolute next-run time to the task's allowed relative range;
- building the model-facing Adaptive execution prompt.

The production random source is `Math.random`. Tests inject fixed values such as `0`, `0.5`, and a value close to `1`, so boundary and midpoint behavior is deterministic.

### Scheduler orchestration

Extend `SchedulerOptions` with an optional random source and add focused Adaptive helpers to `SchedulerInstance`.

When an Adaptive task is created by `/loop <prompt>` or `loop_schedule(action="create")`, immediately replace the store's initial maximum-bound time with a random fallback time.

When an existing Adaptive task becomes due, persist its next random fallback before injecting its prompt into OpenCode. The execution order is:

1. calculate random fallback;
2. call `store.markFired(task.id, fallbackNextDueAt)`;
3. inject the Adaptive prompt into the owning session;
4. allow the model to keep the fallback, override it with `reschedule`, or remove the task with `cancel`;
5. perform no later Adaptive `markFired` write.

This ordering makes model tool writes authoritative regardless of whether `client.session.prompt()` waits for model completion or returns after queueing the prompt.

Fixed and Maintenance tasks retain the existing order: fire first, then calculate and persist their normal next execution time.

## Adaptive Prompt Contract

Only Adaptive tasks receive the scheduling wrapper. The injected text contains:

- the original user request without modification;
- the task ID;
- the minimum and maximum delay in milliseconds;
- the already persisted fallback `nextDueAt` as epoch milliseconds and ISO time;
- an instruction to execute the user request before deciding scheduling;
- guidance to use a shorter delay for rapidly changing, pending, or retryable conditions;
- guidance to use a longer delay for stable or slow-moving conditions;
- an instruction to call `reschedule` exactly when a different time is justified;
- an instruction to make no scheduling call when the fallback is suitable;
- an instruction to call `cancel` when the task is fully complete;
- an instruction not to claim a scheduling change unless the tool succeeds.

The model sees the current session history and the results of the work it performs, so the decision is made after observing the current execution outcome rather than from the original text alone.

## Tool Behavior

For Adaptive tasks, `loop_schedule(action="reschedule")` clamps the requested absolute `nextDueAtMs` to:

```text
[toolCallTime + adaptiveMinMs, toolCallTime + adaptiveMaxMs]
```

The response returns both the requested time and final effective time when they differ. Omitting `nextDueAtMs` selects a fresh random fallback inside the same range.

Fixed and Maintenance task rescheduling retains the current unrestricted absolute-time behavior to avoid an unrelated compatibility change.

## Data and Compatibility

- No persisted state version change is required.
- Existing Adaptive tasks already contain `adaptiveMinMs`, `adaptiveMaxMs`, and `nextDueAt`.
- Legacy tasks missing bounds fall back to the Scheduler's configured defaults.
- No new runtime dependency is introduced.
- Public package entrypoints remain unchanged.

## Error Handling

- Normalize reversed or invalid bounds before random selection or clamping.
- Clamp abnormal random-source output into the valid `[0, 1)` range.
- Persist the fallback before prompt injection so a failed injection does not leave the task immediately due on every ticker cycle.
- Preserve the existing structured logging and fire-history behavior.
- A failed `reschedule` tool call leaves the persisted fallback intact.

## Testing

Add test-first coverage for:

- minimum, midpoint, and maximum-edge random delays;
- initial Adaptive task creation receiving a random fallback;
- model-facing prompt contents and original user request preservation;
- fallback persistence before `client.session.prompt()` is called;
- a reschedule performed during prompt execution overriding the fallback;
- no reschedule preserving the fallback;
- Adaptive requested times below and above bounds being clamped;
- Adaptive reschedule without a requested time choosing a random time;
- Fixed and Maintenance scheduling remaining unchanged;
- the end-to-end ticker path using the new Scheduler execution orchestration.

Run the complete `npm test` suite, install the worktree through OpenCode's file-plugin installer, clear stale plugin cache, restart OpenCode, create a short Adaptive task, and inspect the persisted task plus execution output to verify the random fallback and model scheduling instructions in the real host.

## Out of Scope

- Changing Fixed jitter behavior.
- Changing Maintenance scheduling semantics.
- Adding a new UI control for Adaptive timing.
- Changing the task store schema version.
- Publishing npm or pushing the implementation branch.
