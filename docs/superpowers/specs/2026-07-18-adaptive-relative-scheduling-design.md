# Adaptive Relative Scheduling and Fixed-Mode Classification Design

## Goal

Make a newly created Adaptive `/loop` task execute immediately, let the model decide whether the user's request describes a stable fixed cadence, and remove model-authored epoch arithmetic from ordinary Adaptive rescheduling.

For a request such as `/loop 每隔两分钟查看opencode-plugin-loop插件最新版本`, the first model response executes the version check and converts the task to a jitter-free fixed interval of `120000ms`.

## Confirmed User Experience

- Explicit interval syntax such as `/loop 2m check the version` remains a Fixed task and keeps its existing behavior unless the user supplies a Jitter flag.
- Natural-language syntax such as `/loop 每隔两分钟查看版本` initially creates an Adaptive task with its normal persisted random fallback.
- The same model response that handles the submitted command immediately executes the requested work and then classifies the future schedule.
- An explicit, stable recurring cadence is permanently converted to Fixed mode.
- A task whose next time still depends on its execution result remains Adaptive.
- A model-selected Adaptive relative delay is computed from the tool-call time and stored without Jitter.
- A Fixed task created by Adaptive classification defaults to Jitter disabled.

## Initial Adaptive Execution

The `/loop` command hook currently replaces the submitted command with a synthetic acknowledgement. For a newly created Adaptive task, replace that acknowledgement with an initial execution prompt instead of issuing a nested `client.session.prompt()` request.

This avoids duplicate model turns and ordering races. The initial prompt contains:

- the original user request;
- the created task ID;
- the persisted random fallback time and Adaptive bounds;
- an instruction to complete the user request first;
- an instruction to convert an explicit stable cadence with `set_fixed`;
- an instruction to use `reschedule` with `delayMs` when the next run remains result-dependent;
- an instruction to keep the random fallback by making no scheduling call when appropriate;
- an instruction to cancel when no future run is useful.

The initial execution updates `lastFiredAt` while preserving the already persisted fallback. It does not wait for the ticker. Fixed, Maintenance, list, cancel, pause, resume, and status command responses retain the existing acknowledgement path.

## Tool Contract

### Relative Adaptive rescheduling

Extend `loop_schedule(action="reschedule")` with:

```ts
delayMs?: number
```

For an Adaptive task, the effective delay is clamped to the task's normalized `[adaptiveMinMs, adaptiveMaxMs]` range and the persisted time is calculated as:

```text
toolCallTime + effectiveDelayMs
```

No Jitter is added. The response reports the requested delay, effective delay, and final ISO next-run time.

The existing `nextDueAtMs` remains supported for compatibility. Supplying both `delayMs` and `nextDueAtMs` returns an error before any store write. Omitting both retains the existing behavior of selecting a fresh random Adaptive fallback.

### Permanent Fixed conversion

Add a distinct action:

```ts
loop_schedule({
  action: "set_fixed",
  taskId: "<id>",
  intervalMs: 120000,
  jitterEnabled: false,
})
```

`set_fixed` is valid only for an Adaptive task. `intervalMs` must be finite and at least `1000ms`, matching the existing command parser's minimum; no new maximum is introduced. Session scoping and the existing `all: true` override apply.

The conversion is one atomic store operation that:

- changes `mode` to `fixed`;
- writes `intervalMs`;
- writes `jitterEnabled`;
- removes `adaptiveMinMs` and `adaptiveMaxMs`;
- sets `lastFiredAt` to the conversion time;
- sets `nextDueAt` to the conversion time plus `intervalMs` with no Jitter when disabled.

Calling `set_fixed` for a Fixed or Maintenance task returns an error and leaves the task unchanged. Any validation, scope, or persistence failure leaves the Adaptive task and its fallback unchanged.

## Jitter Configuration

Add an optional persisted task field:

```ts
jitterEnabled?: boolean
```

Compatibility and precedence rules:

1. A task-level value supplied by a command or tool wins.
2. Adaptive-to-Fixed conversion defaults to `false` when the model omits the value.
3. Ordinary Fixed task creation uses `defaultJitterEnabled` when no task value is supplied.
4. Existing Fixed tasks with no field behave as `true`.

Support user configuration through:

- command-level `--jitter=true` and `--jitter=false` on explicit Fixed `/loop` commands;
- tool-level `jitterEnabled` for `create` in Fixed mode and for `set_fixed`;
- programmatic plugin option `defaultJitterEnabled`, defaulting to `true`.

The standard OpenCode `opencode.json` plugin entry remains the unversioned package string. Because current OpenCode configuration validation does not accept arbitrary plugin-specific top-level keys, `defaultJitterEnabled` is documented as a programmatic composition option rather than an `opencode.json` key.

## Scheduler Behavior

- Existing Fixed tasks use Jitter when `jitterEnabled !== false`.
- Jitter-disabled Fixed tasks schedule exactly `intervalMs` after the scheduling origin.
- The 5-second ticker can still introduce up to one ticker period of start latency; this is polling latency, not Jitter.
- Resume and post-fire rearming use the task's persisted Jitter setting.
- Adaptive random fallback behavior remains unchanged unless the model successfully changes the schedule.
- Maintenance behavior remains unchanged.

## Persistence and Compatibility

- Keep persisted state version `1`.
- The optional `jitterEnabled` field is backward compatible.
- Existing Fixed tasks missing the field preserve Jitter.
- Existing Adaptive tasks load unchanged and receive the new Prompt/tool behavior on their next execution.
- No new runtime dependency or public package entrypoint is introduced.

## Error Handling

- Reject simultaneous `delayMs` and `nextDueAtMs` before modifying the task.
- Reject non-finite `delayMs`, `intervalMs`, and absolute timestamps through the tool schema or explicit validation.
- Clamp a valid Adaptive `delayMs` or `nextDueAtMs` only to that task's normalized bounds.
- Reject `set_fixed` without a task ID, without an interval, with an interval below `1000ms`, or against a non-Adaptive task.
- Preserve session ownership checks for every mutation.
- Return requested and effective values so the model cannot incorrectly claim an exact schedule when clamping occurred.

## Testing

Use test-driven development and cover:

- `delayMs` producing `toolCallTime + delayMs` without Jitter;
- lower and upper Adaptive delay clamping;
- conflict rejection for `delayMs` plus `nextDueAtMs` with no store mutation;
- compatibility of absolute `nextDueAtMs` and omitted-time random fallback;
- atomic `set_fixed` conversion and validation failures;
- converted Fixed tasks scheduling without Jitter;
- ordinary and legacy Fixed tasks retaining Jitter by default;
- command-level Jitter true/false parsing and removal from the stored prompt;
- tool-level and programmatic-default Jitter precedence;
- initial Adaptive Prompt replacing the acknowledgement and preserving the original request;
- immediate first execution updating `lastFiredAt` while keeping the random fallback;
- Fixed, Maintenance, and management commands retaining existing behavior;
- full-suite regression coverage.

After automated tests, install the worktree package into OpenCode, clear stale plugin cache, restart OpenCode, and run:

```text
/loop 每隔两分钟查看opencode-plugin-loop插件最新版本
```

Verify that the first model turn checks npm, calls `set_fixed` with `intervalMs: 120000`, persists `jitterEnabled: false`, and that the next execution starts at the persisted due time within the 5-second ticker tolerance.

## Out of Scope

- Removing Jitter from existing Fixed tasks by default.
- Adding arbitrary plugin-specific keys to OpenCode's validated `opencode.json` schema.
- Replacing the ticker with per-task timers.
- Changing Maintenance scheduling.
- Publishing npm, pushing the branch, or merging the existing pull request.
