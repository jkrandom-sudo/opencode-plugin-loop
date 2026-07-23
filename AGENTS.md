# AGENTS.md

## Project

opencode-plugin-loop — `/loop` command plugin for OpenCode (fixed / adaptive / maintenance scheduling).

- Source: `src/` (TypeScript, SolidJS TUI views)
- Tests: `tests/` (node:test, runs against the `dist/` build output)
- Build + test: `npm test` (builds to `dist/` via Babel/tsc, then runs the full suite)

## Development workflow (required)

1. **Branch first**: cut a feature branch (e.g. `feat/xxx`) from the default branch; never commit directly to the default branch.
2. **Verify locally**: `npm test` must pass; for TUI / command-behavior changes, also verify end-to-end in OpenCode.
3. **PR and merge**: open a PR with `gh pr create` and merge into the default branch after verification.
4. **Publish to npm**:
   - Bump `package.json` semver after merging (feat → minor, fix → patch).
   - The npm access token lives in `/Users/wangshuai/Downloads/npm_access_token.txt`; use the most recently issued token in that file.
   - Use the token only via environment variables or throwaway publish-time config (e.g. `//registry.npmjs.org/:_authToken`); **never write it into the repo or commit it**; local `.npmrc` must stay out of git.
   - Publish with `npm publish`, then confirm via `npm view opencode-plugin-loop version`.
