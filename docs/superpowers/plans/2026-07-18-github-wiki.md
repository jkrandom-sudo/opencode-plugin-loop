# GitHub Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a concise English GitHub Wiki for `jkrandom-sudo/opencode-plugin-loop` through the user's authenticated Chrome session.

**Architecture:** Build five validated Markdown drafts outside the source tree, then submit them in dependency order through GitHub's Wiki editor. Home initializes the Wiki, the three guide pages provide focused content, and `_Sidebar` links only to pages that already exist.

**Tech Stack:** GitHub Wiki Markdown, Chrome browser automation, local shell validation, OpenCode/npm project metadata.

## Global Constraints

- Publish exactly these pages: `Home`, `User-Guide`, `Troubleshooting`, `Development`, and `_Sidebar`.
- Write all Wiki content in English.
- Use the unversioned package name in install and configuration examples.
- Document OpenCode `>=1.17.18`, Node.js `>=18`, and current release `0.2.9`.
- Document the actual default `tickerIntervalMs` value of `5000` from `src/index.ts`.
- Preserve task data by default; cache-removal instructions may remove only package caches.
- Submit pages only through the authenticated Chrome UI requested by the user.
- Do not publish a new npm version or modify application source code.

---

### Task 1: Create and validate Wiki drafts

**Files:**
- Create: `/tmp/opencode-plugin-loop-wiki/Home.md`
- Create: `/tmp/opencode-plugin-loop-wiki/User-Guide.md`
- Create: `/tmp/opencode-plugin-loop-wiki/Troubleshooting.md`
- Create: `/tmp/opencode-plugin-loop-wiki/Development.md`
- Create: `/tmp/opencode-plugin-loop-wiki/_Sidebar.md`
- Test: local Markdown content checks

**Interfaces:**
- Consumes: `README.md`, `package.json`, `commands/loop.md`, `src/index.ts`, TUI sources, and the approved design specification.
- Produces: five self-contained Markdown strings ready to paste into GitHub's Wiki editor.

- [ ] **Step 1: Create the Home draft**

Create `/tmp/opencode-plugin-loop-wiki/Home.md` with this exact structure and facts:

````markdown
# opencode-plugin-loop

`opencode-plugin-loop` adds a session-scoped `/loop` command to OpenCode. It can run prompts on fixed or adaptive schedules, persist tasks across restarts, and display command results in a responsive native dialog without writing over the prompt.

## Highlights

- Fixed, adaptive, and maintenance loop modes
- Strict per-session task ownership
- Persistent tasks with deterministic jitter and automatic cleanup
- `list`, `status`, `cancel`, `pause`, `resume`, and `stop-all` commands
- Copy ID, Copy all, and Close actions in a keyboard- and mouse-accessible dialog
- LLM-callable `loop_schedule` and `loop_status` tools

## Requirements

- OpenCode 1.17.18 or newer
- Node.js 18 or newer

## Install or upgrade

```bash
opencode plugin opencode-plugin-loop --global --force
```

Restart OpenCode after installation. The unversioned package name lets the same command install future releases without editing configuration files.

## Documentation

- [User Guide](User-Guide) — installation, commands, dialog controls, and configuration
- [Troubleshooting](Troubleshooting) — cache, version, duplicate-loading, and TUI recovery steps
- [Development](Development) — architecture, source workflow, build, and testing

## Project links

- [npm package](https://www.npmjs.com/package/opencode-plugin-loop)
- [GitHub repository](https://github.com/jkrandom-sudo/opencode-plugin-loop)
- [Issues](https://github.com/jkrandom-sudo/opencode-plugin-loop/issues)
- [MIT License](https://github.com/jkrandom-sudo/opencode-plugin-loop/blob/main/LICENSE)
````

- [ ] **Step 2: Create the User Guide draft**

Create `/tmp/opencode-plugin-loop-wiki/User-Guide.md` with sections for installation, server and TUI configuration, loop modes, subcommands, dialog controls, configuration defaults, and LLM tools. It must include these exact examples:

```bash
opencode plugin opencode-plugin-loop --global --force
```

```json
{
  "plugin": ["opencode-plugin-loop"],
  "command": {
    "loop": {
      "description": "Run a prompt repeatedly on a schedule. Optional intervals: s/m/h/d. Subcommands: list, status, cancel, pause, resume, stop-all.",
      "template": "$ARGUMENTS",
      "agent": "build"
    }
  },
  "opencode-plugin-loop": {
    "maxTasks": 50,
    "taskTtlDays": 7,
    "defaultAdaptiveMinMs": 60000,
    "defaultAdaptiveMaxMs": 3600000,
    "tickerIntervalMs": 5000
  }
}
```

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-plugin-loop"]
}
```

```text
/loop 5m check whether the deployment finished
/loop 30s check the health endpoint
/loop check whether CI passed and address review comments
/loop
/loop list
/loop list --all
/loop cancel <taskId>
/loop cancel <taskId> --all
/loop pause <taskId>
/loop resume <taskId>
/loop stop-all
/loop stop-all --all
```

The dialog section must state:

- Up/Down and Tab/Shift+Tab move selection.
- Enter, Space, or a mouse click activates the selected row.
- Mouse hover selects the row under the pointer.
- Page Up/Page Down scroll long result text.
- Copy ID and Copy all close after a successful copy.
- Clipboard failure keeps the dialog open and displays an error.
- `q` and Esc close the dialog.

The LLM tools section must show `loop_schedule` for create/cancel/reschedule and `loop_status({})` versus `loop_status({ all: true })`.

- [ ] **Step 3: Create the Troubleshooting draft**

Create `/tmp/opencode-plugin-loop-wiki/Troubleshooting.md` with these diagnoses and commands:

```markdown
# Troubleshooting

## Results overlap the prompt

Older releases wrote feedback directly to the terminal. Upgrade to the current release, restart OpenCode, and verify that only the npm installation is active.

## Dialog actions do not move or activate

Version 0.2.9 compiles the dialog with Solid's reactive OpenTUI transform. Verify the registry version, close OpenCode, refresh the package cache, reinstall, and restart.
```

```bash
npm view opencode-plugin-loop version
rm -rf ~/.cache/opencode/packages/opencode-plugin-loop \
  ~/.cache/opencode/packages/opencode-plugin-loop@latest
opencode plugin opencode-plugin-loop --global --force
```

Include a warning that the `rm -rf` command targets plugin package caches only and must be run after closing OpenCode. Include duplicate-installation checks for both configuration files and `~/.config/opencode/plugins/opencode-plugin-loop`. Include installed-version checks using the wrapper dependency and nested package manifest. Include `.opencode/cache/loop/tasks.json`, `history.log`, and OpenCode structured logs, and explicitly state that task storage should not be deleted unless the user intends to reset tasks.

- [ ] **Step 4: Create the Development draft**

Create `/tmp/opencode-plugin-loop-wiki/Development.md` with these sections:

```markdown
# Development

## Entry points

- `opencode-plugin-loop` and `opencode-plugin-loop/server`: scheduling server plugin
- `opencode-plugin-loop/tui`: native interactive result dialog
- Root export: backward-compatible server entrypoint

## Runtime model

Each task owns a `sessionID`. A 5-second ticker checks due tasks, but a task fires only when its session is active. Persistent state lives under `.opencode/cache/loop/`; deterministic jitter spreads execution times; TTL cleanup removes expired tasks; inflight guards prevent duplicate firing during overlapping ticks or hot reloads.

## Build from source
```

Include these exact commands:

```bash
git clone https://github.com/jkrandom-sudo/opencode-plugin-loop.git
cd opencode-plugin-loop
npm install
npm run build
npm test
opencode plugin "file:///absolute/path/to/opencode-plugin-loop" --global --force
```

Document that `scripts/build.mjs` emits declarations with TypeScript and compiles TS/TSX with Babel plus Solid's universal transform. List the responsibilities of `src/index.ts`, `src/scheduler.ts`, `src/store.ts`, `src/tools/loop-tools.ts`, `src/tui.ts`, `src/tui-feedback-model.ts`, `src/tui-dialog-actions.ts`, `src/tui-dialog-interaction.ts`, `src/tui-dialog-layout.ts`, and `src/tui-dialog-view.tsx`. End with a local verification checklist for fixed task creation, `/loop list`, all three actions, keyboard wraparound, mouse hover/click, task cancellation, and `npm test`.

- [ ] **Step 5: Create the sidebar draft**

Create `/tmp/opencode-plugin-loop-wiki/_Sidebar.md` with this exact content:

```markdown
## opencode-plugin-loop

- [Home](Home)
- [User Guide](User-Guide)
- [Troubleshooting](Troubleshooting)
- [Development](Development)

---

- [npm Package](https://www.npmjs.com/package/opencode-plugin-loop)
- [GitHub Repository](https://github.com/jkrandom-sudo/opencode-plugin-loop)
```

- [ ] **Step 6: Run local content validation**

Run:

```bash
test "$(find /tmp/opencode-plugin-loop-wiki -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')" = "5"
rg -n 'opencode-plugin-loop --global --force' /tmp/opencode-plugin-loop-wiki/Home.md /tmp/opencode-plugin-loop-wiki/User-Guide.md /tmp/opencode-plugin-loop-wiki/Troubleshooting.md
rg -n 'tickerIntervalMs.*5000|5-second ticker' /tmp/opencode-plugin-loop-wiki/User-Guide.md /tmp/opencode-plugin-loop-wiki/Development.md
rg -n '\[User Guide\]\(User-Guide\)|\[Troubleshooting\]\(Troubleshooting\)|\[Development\]\(Development\)' /tmp/opencode-plugin-loop-wiki/Home.md /tmp/opencode-plugin-loop-wiki/_Sidebar.md
if rg -n 'opencode-plugin-loop@[0-9]' /tmp/opencode-plugin-loop-wiki; then exit 1; fi
```

Expected: five files exist; required commands, defaults, and links are found; no version-pinned install string is found.

### Task 2: Publish content pages through Chrome

**Files:**
- Read: `/tmp/opencode-plugin-loop-wiki/Home.md`
- Read: `/tmp/opencode-plugin-loop-wiki/User-Guide.md`
- Read: `/tmp/opencode-plugin-loop-wiki/Troubleshooting.md`
- Read: `/tmp/opencode-plugin-loop-wiki/Development.md`

**Interfaces:**
- Consumes: validated Markdown drafts from Task 1 and the authenticated Chrome GitHub session.
- Produces: four public Wiki content pages.

- [ ] **Step 1: Connect to the requested Chrome session**

Initialize the Chrome browser binding, read its complete documentation, and select or open `https://github.com/jkrandom-sudo/opencode-plugin-loop/wiki/_new`.

- [ ] **Step 2: Publish Home**

Use the GitHub Wiki editor to submit title `Home`, body from `Home.md`, and edit message `Create Wiki home`. Verify the resulting URL ends in `/wiki` or `/wiki/Home` and the page heading is visible.

- [ ] **Step 3: Publish User Guide**

Return to `/wiki/_new`; submit title `User Guide`, body from `User-Guide.md`, and edit message `Add user guide`. Verify `/wiki/User-Guide` renders.

- [ ] **Step 4: Publish Troubleshooting**

Return to `/wiki/_new`; submit title `Troubleshooting`, body from `Troubleshooting.md`, and edit message `Add troubleshooting guide`. Verify `/wiki/Troubleshooting` renders.

- [ ] **Step 5: Publish Development**

Return to `/wiki/_new`; submit title `Development`, body from `Development.md`, and edit message `Add development guide`. Verify `/wiki/Development` renders.

### Task 3: Publish navigation and verify the Wiki

**Files:**
- Read: `/tmp/opencode-plugin-loop-wiki/_Sidebar.md`
- Test: rendered GitHub Wiki pages

**Interfaces:**
- Consumes: four published pages and the validated sidebar draft.
- Produces: shared navigation and a verified public Wiki.

- [ ] **Step 1: Publish `_Sidebar`**

Open `/wiki/_new`; submit title `_Sidebar`, body from `_Sidebar.md`, and edit message `Add Wiki navigation`.

- [ ] **Step 2: Verify navigation**

Open Home, User Guide, Troubleshooting, and Development from the rendered sidebar. Verify each URL resolves, the expected H1 is visible, and no editor error banner appears.

- [ ] **Step 3: Verify canonical Home URL**

Open `https://github.com/jkrandom-sudo/opencode-plugin-loop/wiki` and verify the Home content, sidebar, install command, requirements, and project links render.

- [ ] **Step 4: Record completion evidence**

Report the five published page URLs, local validation results, and any differences GitHub applied to page slugs. Do not publish npm or push the documentation-planning branch unless separately requested.
