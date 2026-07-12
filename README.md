# opencode-plugin-loop

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

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-plugin-loop"]
}
```

The plugin auto-installs its bundled command at `~/.config/opencode/commands/loop.md`.

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

## License

MIT