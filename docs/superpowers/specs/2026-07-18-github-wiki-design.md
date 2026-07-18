# GitHub Wiki Design

## Goal

Create a concise English GitHub Wiki for `jkrandom-sudo/opencode-plugin-loop` that helps users install, operate, troubleshoot, and develop the current `0.2.9` release without duplicating the README into one oversized page.

## Audience

- OpenCode users installing or upgrading the plugin.
- Users managing scheduled `/loop` tasks and the interactive result dialog.
- Maintainers diagnosing installation, cache, session, or TUI problems.
- Contributors building and testing the server and TUI entrypoints locally.

## Information Architecture

The Wiki contains four content pages plus a shared sidebar.

### Home

Purpose: provide a short project overview and direct readers to the right guide.

Content:

- One-paragraph description of the plugin and its per-session scheduling model.
- Compact list of core capabilities.
- Requirements: OpenCode 1.17.18 or newer and Node.js 18 or newer.
- Recommended install and upgrade command:

  ```bash
  opencode plugin opencode-plugin-loop --global --force
  ```

- Links to User Guide, Troubleshooting, and Development.
- Links to the npm package, GitHub repository, issues, and MIT license.

### User Guide

Purpose: cover the complete user-facing workflow without implementation details.

Content:

- Installation through OpenCode's plugin installer.
- Unversioned entries in `opencode.json` and `tui.json` so upgrades do not require configuration edits.
- Fixed, adaptive, and bare `/loop` modes with examples.
- Session-scoped task commands: `list`, `status`, `cancel`, `pause`, `resume`, and `stop-all`, including `--all` behavior.
- Interactive result dialog actions: Copy ID, Copy all, and Close.
- Keyboard controls: Up, Down, Tab, Shift+Tab, Enter, Space, Page Up, Page Down, `q`, and Esc.
- Mouse hover and click behavior.
- Configuration options and their defaults.
- Short overview of `loop_schedule` and `loop_status` for LLM-driven use.

### Troubleshooting

Purpose: give users direct diagnosis and recovery steps for known installation and dialog problems.

Content:

- Output or task lines overlapping the prompt: identify releases older than the native dialog and upgrade.
- Copy ID, Copy all, or Close selection not moving: verify version 0.2.9, remove stale cache, reinstall, and restart OpenCode.
- Duplicate plugin loading: check both configured npm plugins and copied plugins under `~/.config/opencode/plugins/`.
- Old package cache: remove the `opencode-plugin-loop` cache directories, then reinstall with `--force`.
- Version verification using npm metadata and the installed cache package manifest.
- Storage and diagnostic locations: `.opencode/cache/loop/tasks.json`, `history.log`, and OpenCode structured logs.
- Recovery guidance must preserve task data unless the user explicitly chooses to delete it.

### Development

Purpose: explain the minimum architecture and workflow needed to contribute safely.

Content:

- Server and TUI entrypoints and the backward-compatible root export.
- Per-session task ownership, active-session scheduling, the 15-second ticker, persistence, jitter, TTL cleanup, and inflight guards.
- Source installation and file-plugin registration.
- Build, test, and local OpenCode verification commands.
- Key source files grouped by scheduler, store, tools, TUI feedback, dialog interaction, layout, and view responsibilities.
- Published TSX is compiled through the Solid universal transform so selection state updates the OpenTUI view reactively.

### `_Sidebar`

Purpose: provide consistent navigation on every Wiki page.

Content, in this order:

1. Home
2. User Guide
3. Troubleshooting
4. Development
5. npm Package
6. GitHub Repository

## Page Naming and Links

- `Home`
- `User-Guide`
- `Troubleshooting`
- `Development`
- `_Sidebar`

Internal links use GitHub Wiki page names, for example `[User Guide](User-Guide)`. External links use canonical HTTPS URLs. Commands and JSON examples use fenced code blocks with the correct language identifier.

## Source of Truth

Wiki facts come from the remote `main` branch at version `0.2.9`, especially `README.md`, `package.json`, `commands/loop.md`, current tests, and the implemented TUI source. Version-specific troubleshooting may name `0.2.9`; installation and configuration examples use the unversioned package name.

## Publishing Workflow

1. Open the authenticated Chrome page at `https://github.com/jkrandom-sudo/opencode-plugin-loop/wiki/_new`.
2. Create Home first, which initializes the Wiki repository.
3. Create User Guide, Troubleshooting, and Development.
4. Create `_Sidebar` last so every content page already exists when navigation is added.
5. Use concise commit messages in the Wiki editor, one page per submission.

No source-code or npm package release is required for this documentation-only operation.

## Validation

- Every page renders successfully in the GitHub Wiki.
- All four page links in `_Sidebar` resolve without redirects to missing pages.
- Install and upgrade commands use the unversioned package name.
- Requirements match `package.json`.
- User Guide commands match the current command parser and README.
- Troubleshooting steps do not expose credentials or delete task data by default.
- Development build and test commands match current package scripts.
- The final Home page is visible at `https://github.com/jkrandom-sudo/opencode-plugin-loop/wiki`.
