# opencode-plugin-loop

[![npm version](https://img.shields.io/npm/v/opencode-plugin-loop.svg)](https://www.npmjs.com/package/opencode-plugin-loop)
[![npm downloads](https://img.shields.io/npm/dm/opencode-plugin-loop.svg)](https://www.npmjs.com/package/opencode-plugin-loop)
[![CI](https://github.com/jkrandom-sudo/opencode-plugin-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/jkrandom-sudo/opencode-plugin-loop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/jkrandom-sudo/opencode-plugin-loop/blob/main/LICENSE)

A drop-in `/loop` command for [opencode](https://opencode.ai), modeled after Claude Code's `/loop`. Each `/loop` task is bound to the session that created it — never leaks to other sessions.

> **Upgrading to 0.4.0?** Two behavior changes to know about: (1) since 0.3.0, tasks die with the opencode process by default (`ephemeralTasks: false` restores persistence) — the upgrade drops the pre-0.3.0 `tasks.json` once; (2) scheduling-like input that used to silently create an Adaptive task (cron syntax, bare intervals like `/loop 5m`, unknown flags) now returns an explicit error pointing at `/loop help`.

## Features

- **`/loop 5m <prompt>`** — fixed interval (s/m/h/d supported)
- **`/loop <prompt>`** — runs immediately in Adaptive mode, then keeps the random fallback, reschedules from the result, or converts a clear recurring cadence to Fixed
- **`/loop`** — bare: read `.opencode/loop.md` or run built-in maintenance, immediately
- **`/loop 30s --once <prompt>`** — one-shot: fires once, then auto-cancels
- **`/loop help`** — full usage, flags, and examples in the terminal
- **Claude Code-style flags** — `--cancel/--list/--status/--pause/--resume/--stop/--stop-all` map to the matching subcommand
- **Per-session scoping** — tasks are bound to a `sessionID`; other sessions never see or fire them
- **Subcommands** — `list | status | cancel | pause | resume | stop-all` (session-scoped; add `--all` to cross sessions)
- **Internal ticker** — 5s loop drives task firing (no longer depends on `session.idle` events)
- **Single-leader instance lock** — when several plugin instances share one `tasks.json` (case-variant plugin paths, per-command `opencode run` instances), only the leader fires; merge-writes prevent task loss
- **Inflight guard** — double-set at ticker and `fireTask` level prevents double-firing even if opencode hot-reloads the plugin
- **Wall-clock scheduling** — fixed tasks anchor to fire start; model-turn duration never inflates the interval
- **Ephemeral lifecycle (default)** — tasks die with the OpenCode process and are dropped on the next start, matching Claude Code's `/loop`. Set `ephemeralTasks: false` to persist tasks across process restarts
- **Auto-cleanup on `session.deleted`** — all tasks for that session are cancelled automatically
- **Configurable Jitter** — deterministic Fixed-task offset, controllable per command, tool call, or programmatic default
- **Auto-expire** — tasks idle for more than 7 days are removed on load (active tasks never expire)
- **Max 50 concurrent tasks**
- **LLM-callable tools** — `loop_schedule`, `loop_status` (session-bound by default)
- **Inline results, Claude Code style** — every `/loop` result (create, list, cancel, pause, resume, stop-all, failures) is presented by the model directly in the conversation, in the user's own language — task lists render as a markdown table. No dialogs, no toasts

## Requirements

- OpenCode **1.17.18 or newer**
- Node.js **18 or newer**

## Install

### Option 1: From npm (recommended)

Use OpenCode's plugin installer so the package's server and TUI entrypoints are both detected and added to the correct configs:

```bash
opencode plugin opencode-plugin-loop --global --force
```

This adds the unversioned package name to both global `opencode.json` and `tui.json`, so future upgrades do not require editing a version number.

If `/loop` is not already defined in your OpenCode configuration, add the command definition shown below to `opencode.json`. OpenCode detects both plugin entrypoints from the npm package, but it does not currently copy the bundled `commands/loop.md` file into your config directory.

### Upgrade

To update an existing installation to the current npm release, rerun the same command:

```bash
opencode plugin opencode-plugin-loop --global --force
```

The `--force` flag replaces the installed plugin version and refreshes both global config entries without requiring a version-number change. Restart OpenCode after the command completes.

**Upgrade self-check.** opencode keeps its own plugin package cache at `~/.cache/opencode/packages`, and `--force` does not always refresh it. If an upgrade reports success but behavior does not change (e.g. `npm view opencode-plugin-loop version` disagrees with what you see), clear the cache and restart:

```bash
rm -rf ~/.cache/opencode/packages/opencode-plugin-loop*
```

Then verify with `/loop help` — new flags and subcommands show up there immediately.

### Option 2: Manual configuration

Add the same package name to the `plugin` array in both configuration files.

Server config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-plugin-loop"],
  "command": {
    "loop": {
      "description": "Run prompts on a schedule. Intervals: s/m/h/d. Subcommands: help | list | status | cancel <id> | pause <id> | resume <id> | stop-all (add --all to cross sessions)",
      "template": "$ARGUMENTS",
      "agent": "build"
    }
  }
}
```

TUI config (`~/.config/opencode/tui.json`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-plugin-loop"]
}
```

### Option 3: From source (development)

```bash
git clone https://github.com/jkrandom-sudo/opencode-plugin-loop.git
cd opencode-plugin-loop
npm install
npm run build
opencode plugin "file:///absolute/path/to/opencode-plugin-loop" --global --force
```

Re-run `npm run build` after editing `src/`, then restart OpenCode to load the rebuilt file plugin.

## Usage

### Fixed interval
```
/loop 5m check if the deploy finished
/loop 30s ping the health endpoint
/loop 2h look for failing CI runs
/loop 2m --jitter=false check the latest package version
/loop 30s --once remind me to stretch   # one-shot: fires once, then auto-cancels
```

Fixed tasks use deterministic Jitter by default for backward compatibility. Add
`--jitter=false` for an exact interval or `--jitter=true` to enable it explicitly.
The flag is scheduling metadata and is removed from the repeated prompt.

### Adaptive interval (LLM decides next fire time)
```
/loop check whether CI passed and address any review comments
/loop every two minutes check the latest opencode-plugin-loop version
```

The natural-language form runs the request immediately in the current model turn. Each Adaptive task first receives a persisted random fallback time inside the configured 1–60 minute range. After completing the request, the LLM classifies the schedule:

- a clear stable cadence such as “every two minutes” calls `loop_schedule(action="set_fixed", intervalMs=120000)` and becomes a permanent Fixed task;
- a result-dependent next check calls `loop_schedule(action="reschedule", delayMs=...)`;
- a suitable fallback is kept by making no scheduling call;
- a completed task with no useful future check calls `loop_schedule(action="cancel")`.

Adaptive-to-Fixed conversion defaults to `jitterEnabled: false`, so an explicit cadence remains exact.

The fallback is written before the prompt is injected. A successful `reschedule` therefore replaces the fallback and is not overwritten after the model finishes. The preferred `delayMs` is relative to tool-call time, avoiding epoch arithmetic. An in-range model delay is stored exactly without Jitter; only an out-of-range request is clamped to the task's configured minimum or maximum delay. Fixed and Maintenance rescheduling remains unchanged. The legacy absolute `nextDueAtMs` remains supported, but passing it together with `delayMs` returns an error without changing the task.

### Bare `/loop` — custom default prompt
Create `.opencode/loop.md` (project) or `<user>/.opencode/loop.md` (user) with your maintenance instructions:
```markdown
Check the release branch PR. If CI is red, pull the failing log,
diagnose, and push a minimal fix. If new review comments have arrived,
address each one. If everything is green, say so in one line.
```

### Subcommands

All subcommands are **session-scoped by default**. Add `--all` to operate across all sessions.

```
/loop help                              # full usage, flags, and examples
/loop list                              # show tasks in current session
/loop list --all                        # show all sessions (with [s:xxxx] tags)
/loop status                            # alias for list
/loop cancel <taskId>                   # cancel one task in current session
/loop cancel <taskId> --all             # override scope
/loop pause <taskId>                     # pause one
/loop resume <taskId>                    # resume one (re-arms per mode)
/loop stop-all                          # cancel all tasks in current session
/loop stop-all --all                    # cancel ALL tasks across sessions
```

If you try `cancel <id>` for a task owned by another session, you'll get a refusal with a hint to add `--all`. The same strict scoping applies to `loop_schedule` and `loop_status` tools.

### Migrating from Claude Code

| Claude Code `/loop` | opencode-plugin-loop |
|---|---|
| `/loop 5m <prompt>` | identical |
| `/loop <prompt>` (self-paced) | Adaptive: runs now, model picks the next check (fallback 1m–1h) |
| cancel/list via cron tools | `/loop cancel <id>`, `/loop list` |
| `--cancel`, `--list`, `--stop` | accepted — mapped to `cancel`, `list`, `stop` |
| one-off reminder ("in 30m tell me X") | `/loop 30s --once <prompt>` |
| jobs die when the session ends | same default since 0.3.0 (`ephemeralTasks: false` opts out) |
| cron expressions (`*/5 * * * *`) | not supported — use `5m` form (explicit error) |

Two behavioral differences worth knowing: tasks only fire for the **currently active session** (switch sessions and the others wait; switch back and they catch up once), and fixed tasks fire on a 5-second ticker rather than exact wall-clock cron times (up to one ticker period late).

### Inline results

Every `/loop` command result is presented by the model directly in the conversation — Claude Code style, in the same language you used:

- **Create** — a short confirmation with the task, schedule, and job ID (plus how to cancel)
- **List / status** — a markdown table of your tasks (Job ID, frequency, content, type) with the management commands below it
- **Cancel / pause / resume / stop-all** — a concise confirmation of what changed and whether the task will trigger again
- **Failures** — a brief explanation of what went wrong

No dialogs, no toasts — the conversation is the only output surface.

### Programmatic (LLM tools)

The plugin registers two LLM-callable tools. Both are session-bound by default; pass `all: true` to cross.

```typescript
loop_schedule({
  action: "create",
  prompt: "check the deploy",
  intervalMs: 300_000,
  // sessionID auto-bound from ctx
})

loop_schedule({
  action: "cancel",
  taskId: "abc12345",
  // refuses if taskId belongs to another session (pass all: true to override)
})

loop_schedule({
  action: "reschedule",
  taskId: "abc12345",
  delayMs: 5 * 60_000,
})

loop_schedule({
  action: "set_fixed",
  taskId: "abc12345",
  intervalMs: 2 * 60_000,
  jitterEnabled: false, // default for Adaptive-to-Fixed conversion
})

loop_status({})               // current session only
loop_status({ all: true })     // all sessions
```

## Configuration

The package name in the `plugin` array is the only plugin-specific entry required in
`opencode.json`. Current OpenCode releases validate that file and reject arbitrary
top-level keys such as `"opencode-plugin-loop"`.

The built-in runtime defaults are:

| Setting | Default |
|---------|---------|
| Maximum persisted tasks | 50 |
| Task expiry | 7 days |
| Adaptive fallback range | 1 minute to 1 hour |
| Scheduler ticker | 5 seconds |
| New Fixed-task Jitter | enabled |
| Ephemeral tasks | enabled |

**Ephemeral lifecycle.** With `ephemeralTasks` enabled (the default), every
`tasks.json` records the pid and start time of the process that wrote it. On
load, tasks written by any other process — e.g. after OpenCode exits and
restarts — are dropped, so loop tasks never outlive the process that created
them (the same lifecycle as Claude Code's `/loop`). Same-process plugin reloads
keep their tasks. Pass `{ ephemeralTasks: false }` in the plugin options to
restore the previous behavior of persisting tasks across process restarts. Note
that upgrading from a release without process-identity tracking drops the
existing `tasks.json` once, since it carries no trusted writer identity.

Adaptive minimum and maximum delays are persisted on each task. The random fallback
and any model-requested `reschedule` are both constrained by that task's bounds. Jitter
is not added to a model-selected Adaptive time.

For programmatic composition, `LoopConfig.defaultJitterEnabled` controls newly
created Fixed tasks and defaults to `true`. An explicit command
`--jitter=true|false` or tool argument `jitterEnabled` overrides that default.
Existing persisted Fixed tasks without a `jitterEnabled` field retain the legacy
Jitter-on behavior. Because the ticker checks every 5 seconds, actual prompt
injection can occur up to one ticker period after an exact due time.

## Per-session architecture

Each `/loop` task carries a `sessionID` field:

| Lifecycle event | Behavior |
|-----------------|----------|
| User runs `/loop` in session A | Task created with `sessionID = A` |
| Ticker fires every 5s | Only fires tasks where `sessionID === activeSessionID` (tracked via `chat.message` hook) |
| User runs `/loop` in session B | Session B becomes active; A's task waits |
| `session.deleted` for session A | All A's tasks cancelled automatically |
| Plugin reload (`opencode` hot-reload) | Old tickers stop, new ticker starts; in-flight tasks guarded by `inflight` Set |
| Process restart (new pid) | With `ephemeralTasks` enabled (default), all tasks from the previous process are dropped on load; with it disabled, tasks resume as before |
| Old `tasks.json` without `sessionID` | Dropped on load (with log message) |

## Storage

Tasks persist to `.opencode/cache/loop/tasks.json` (per project). Fire history is logged to `history.log` next to the store. The state file also records the writer's `pid` and `startedAt`, which the ephemeral lifecycle uses to detect process restarts.

## Troubleshooting

### Package entrypoints

Current releases expose separate `opencode-plugin-loop/server` and `opencode-plugin-loop/tui` entrypoints so OpenCode installs that auto-load both keep working (the TUI entrypoint is a no-op since results are presented inline). The root export remains the v1-compatible server module for backward compatibility. Programmatic consumers should use the named factory:

```typescript
import { LoopPlugin } from "opencode-plugin-loop"
```

### Task lines overlap the input area

Older releases wrote `/loop` results directly to the terminal or into native dialogs/toasts. Upgrade to the current release: every result is presented inline by the model, and runtime diagnostics go to OpenCode's structured application log.

Also make sure the plugin is installed from only one source. OpenCode loads npm plugins from `opencode.json` and copied plugins under `~/.config/opencode/plugins/` independently, even when they have the same package name.

If `opencode.json` already contains `"plugin": ["opencode-plugin-loop"]`, check for a stale copied installation:

```bash
ls ~/.config/opencode/plugins/opencode-plugin-loop
```

If that directory exists, move it out of the auto-loaded plugin directory and restart OpenCode:

```bash
mv ~/.config/opencode/plugins/opencode-plugin-loop \
  ~/.config/opencode/plugins/opencode-plugin-loop.backup
```

Keep the backup until the npm installation has been verified, then remove it when no longer needed.

## License

MIT
