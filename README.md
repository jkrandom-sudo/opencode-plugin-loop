# opencode-plugin-loop

[![npm version](https://img.shields.io/npm/v/opencode-plugin-loop.svg)](https://www.npmjs.com/package/opencode-plugin-loop)
[![npm downloads](https://img.shields.io/npm/dm/opencode-plugin-loop.svg)](https://www.npmjs.com/package/opencode-plugin-loop)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/jkrandom-sudo/opencode-plugin-loop/blob/main/LICENSE)

A drop-in `/loop` command for [opencode](https://opencode.ai), modeled after Claude Code's `/loop`. Each `/loop` task is bound to the session that created it — never leaks to other sessions.

## Features

- **`/loop 5m <prompt>`** — fixed interval (s/m/h/d supported)
- **`/loop <prompt>`** — adaptive interval (1 min–1 hr, LLM-decided)
- **`/loop`** — bare: read `.opencode/loop.md` or run built-in maintenance
- **Per-session scoping** — tasks are bound to a `sessionID`; other sessions never see or fire them
- **Subcommands** — `list | status | cancel | pause | resume | stop-all` (session-scoped; add `--all` to cross sessions)
- **Internal ticker** — 15s loop drives task firing (no longer depends on `session.idle` events)
- **Inflight guard** — double-set at ticker and `fireTask` level prevents double-firing even if opencode hot-reloads the plugin
- **Persistent tasks** — survive session restarts; auto-migrated (tasks without `sessionID` are dropped on load)
- **Auto-cleanup on `session.deleted`** — all tasks for that session are cancelled automatically
- **Jitter** — deterministic offset based on task ID (matches Claude Code's algorithm)
- **Auto-expire** — tasks older than 7 days are removed on load
- **Max 50 concurrent tasks**
- **LLM-callable tools** — `loop_schedule`, `loop_status` (session-bound by default)
- **Interactive Loop results** — `/loop` results open in a dedicated native dialog instead of writing over the prompt
- **Clipboard actions** — copy the complete result or copy any displayed task ID with one action
- **Responsive layout** — short or narrow terminals keep the dialog inside the viewport with independently scrollable result and action areas
- **Easy dismissal** — choose **Close**, press `q`, or use the native dialog's `Esc` key

## Requirements

- OpenCode **1.17.18 or newer** for the interactive TUI companion
- Node.js **18 or newer**

The scheduling server plugin still has a native toast fallback, while supported OpenCode versions install both package entrypoints automatically.

## Install

### Option 1: From npm (recommended)

Use OpenCode's plugin installer so the package's server and TUI entrypoints are both detected and added to the correct configs:

```bash
opencode plugin opencode-plugin-loop@0.2.6 --global --force
```

This pins version 0.2.6 and updates both global `opencode.json` and `tui.json`.

If `/loop` is not already defined in your OpenCode configuration, add the command definition shown below to `opencode.json`. OpenCode detects both plugin entrypoints from the npm package, but it does not currently copy the bundled `commands/loop.md` file into your config directory.

To upgrade after a newer version is released, replace `0.2.6` in the command with the target version and run it again with `--force`.

### Option 2: Manual configuration

Add the same pinned package to the `plugin` array in both configuration files.

Server config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-plugin-loop@0.2.6"],
  "command": {
    "loop": {
      "description": "定时重复执行 prompt。可选间隔: s/m/h/d。子命令: list | status | cancel <id> | pause <id> | resume <id> | stop-all（加 --all 跨 session）",
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
  "plugin": ["opencode-plugin-loop@0.2.6"]
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
```

### Adaptive interval (LLM decides next fire time)
```
/loop check whether CI passed and address any review comments
```

The LLM receives the prompt each iteration and uses `loop_schedule` to pick the next interval (1–60 min).

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
/loop list                              # show tasks in current session
/loop list --all                        # show all sessions (with [s:xxxx] tags)
/loop status                            # alias for list
/loop cancel <taskId>                   # cancel one task in current session
/loop cancel <taskId> --all             # override scope
/loop pause <taskId>                     # pause one
/loop resume <taskId>                    # resume one (re-arms fixed interval)
/loop stop-all                          # cancel all tasks in current session
/loop stop-all --all                    # cancel ALL tasks across sessions
```

If you try `cancel <id>` for a task owned by another session, you'll get a refusal with a hint to add `--all`. The same strict scoping applies to `loop_schedule` and `loop_status` tools.

### Interactive result dialog

Every `/loop` command result opens in a separate native OpenCode dialog. It keeps task output away from the prompt and provides:

- **Copy ID: `<taskId>`** for every distinct task shown in the result
- **Copy all** for the exact complete result text
- **Close** to dismiss the dialog

Use the mouse or arrow keys to select an action, then press `Enter` or `Space`. A successful **Copy ID** or **Copy all** action shows a confirmation and closes the dialog immediately; if clipboard access fails, the dialog stays open and shows an error. Press `Page Up` or `Page Down` to scroll long result text, or press `q` or `Esc` to close. In short or narrow terminals, the dialog scales to the available viewport and keeps the result and action lists independently scrollable. A newer Loop result replaces the previous Loop dialog rather than stacking another one.

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
  nextDueAtMs: Date.now() + 5 * 60_000,
})

loop_status({})               // current session only
loop_status({ all: true })     // all sessions
```

## Configuration

Pass options via `opencode.json`:

```json
{
  "plugin": ["opencode-plugin-loop"],
  "opencode-plugin-loop": {
    "maxTasks": 50,
    "taskTtlDays": 7,
    "defaultAdaptiveMinMs": 60000,
    "defaultAdaptiveMaxMs": 3600000,
    "tickerIntervalMs": 15000
  }
}
```

## Per-session architecture

Each `/loop` task carries a `sessionID` field:

| Lifecycle event | Behavior |
|-----------------|----------|
| User runs `/loop` in session A | Task created with `sessionID = A` |
| Ticker fires every 15s | Only fires tasks where `sessionID === activeSessionID` (tracked via `chat.message` hook) |
| User runs `/loop` in session B | Session B becomes active; A's task waits |
| `session.deleted` for session A | All A's tasks cancelled automatically |
| Plugin reload (`opencode` hot-reload) | Old tickers stop, new ticker starts; in-flight tasks guarded by `inflight` Set |
| Old `tasks.json` without `sessionID` | Dropped on load (with log message) |

## Storage

Tasks persist to `.opencode/cache/loop/tasks.json` (per project). Fire history is logged to `history.log` next to the store.

## Troubleshooting

### Package entrypoints in 0.2.6

Version 0.2.6 exposes separate `opencode-plugin-loop/server` and `opencode-plugin-loop/tui` entrypoints so OpenCode can load the scheduler and responsive interactive dialog independently. The root export remains the v1-compatible server module for backward compatibility. Programmatic consumers should use the named factory:

```typescript
import { LoopPlugin } from "opencode-plugin-loop"
```

### Task lines overlap the input area

Versions before 0.2.4 wrote `/loop` results directly to the terminal. OpenCode owns and redraws the terminal UI, so those writes could leave task IDs and prompts over the input area. Upgrade to 0.2.6 for the responsive interactive dialog; runtime diagnostics go to OpenCode's structured application log.

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
