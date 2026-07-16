# Loop dialog reactivity implementation plan

> **Goal:** Restore visible keyboard and pointer selection in the Loop dialog by compiling OpenTUI Solid TSX with the required reactive transform, then verify the packed result in the real local OpenCode TUI.

## Task 1: Add failing build-pipeline regression tests

**Files:**

- Modify: `tests/package-exports.test.mjs`
- Inspect after build: `dist/tui-dialog-view.js`

1. Add a test that reads `tsconfig.json` and expects `compilerOptions.jsx` to be `preserve`.
2. Add a test that expects `package.json` to invoke a repository build script rather than raw `tsc` JavaScript emission.
3. Add a test that reads `dist/tui-dialog-view.js`, rejects `@opentui/solid/jsx-runtime`, and requires Solid-generated reactive update machinery for the selected-row styles.
4. Run the focused package test with the current build:

   ```bash
   npm run build && node --test tests/package-exports.test.mjs
   ```

5. Confirm the new assertions fail for the current `react-jsx`/`tsc` pipeline.

## Task 2: Implement the Solid-aware Node build

**Files:**

- Create: `scripts/build.mjs`
- Modify: `tsconfig.json`
- Modify: `package.json`
- Modify: `package-lock.json`

1. Change TypeScript JSX handling to `preserve`.
2. Add direct development dependencies on `@babel/core`, `@babel/preset-typescript`, and `babel-preset-solid`.
3. Add `scripts/build.mjs` that:
   - removes stale `dist` output;
   - invokes TypeScript with `--emitDeclarationOnly` for strict checking and declarations;
   - walks `src` recursively;
   - strips types from `.ts` and `.tsx` with Babel;
   - applies Solid universal generation to `.tsx` with module name `@opentui/solid`;
   - writes matching `.js` paths beneath `dist`;
   - exits non-zero on any incomplete or failed transform.
4. Point `npm run build` at `node scripts/build.mjs`; keep `prepare`, `test`, and `prepublishOnly` using the shared build command.
5. Run the focused regression test and confirm it passes:

   ```bash
   npm run build && node --test tests/package-exports.test.mjs
   ```

6. Inspect the built dialog module to confirm that selected-row colors are updated through Solid effects and no JSX runtime import remains.
7. Commit the build and test changes.

## Task 3: Verify package integrity and existing behavior

**Files:**

- Verify: `dist/**`
- Verify: packed npm tarball

1. Run the complete test suite:

   ```bash
   npm test
   ```

2. Run formatting/diff safety checks:

   ```bash
   git diff --check
   ```

3. Pack the package without publishing:

   ```bash
   npm pack --json --pack-destination /tmp/opencode-loop-reactivity
   ```

4. Inspect the tarball manifest and files to confirm `dist/tui.js`, `dist/tui-dialog-view.js`, declarations, commands, README, and license are included.
5. Install/extract the tarball in an isolated temporary project and import the root, server, and TUI entrypoints under the expected host dependencies.

## Task 4: Replace local caches and run a real OpenCode smoke test

**Files/state:**

- Remove and recreate: `~/.cache/opencode/packages/opencode-plugin-loop`
- Remove and recreate: `~/.cache/opencode/packages/opencode-plugin-loop@latest`
- Preserve: `~/.config/opencode/opencode.json`
- Preserve: `~/.config/opencode/tui.json`

1. Record current plugin configuration and confirm it remains unpinned (`opencode-plugin-loop` / `opencode-plugin-loop@latest` as already configured).
2. Remove both Loop plugin cache wrappers so stale `0.2.8` JavaScript cannot be reused.
3. Recreate the normal wrapper, install the packed local artifact into it without changing the user's configuration, and verify the installed dialog module has the Solid reactive transform.
4. Start a fresh OpenCode PTY owned by this task only.
5. Create or list a Loop task and open the Loop result dialog.
6. Verify the visible highlight moves through `Copy ID`, `Copy all`, and `Close` with:
   - `Down` and `Up`;
   - `Tab` and `Shift+Tab`;
   - mouse hover/click where the PTY/UI supports pointer injection.
7. Verify `Enter` activates the selected action and copy actions close the dialog.
8. Stop only the test-owned OpenCode process, leaving existing user sessions and Loop tasks untouched.
9. Re-run a clean cache inspection to confirm no diagnostic hooks or old generated JSX remain.

## Task 5: Final review and handoff

1. Review the complete branch diff for scope, generated-code assumptions, and accidental configuration changes.
2. Run the verification commands again from a clean build.
3. Report the root cause, changed files, exact automated test results, real OpenCode interaction evidence, and the local cache state.
4. Do not push GitHub changes or publish npm unless the user explicitly requests those remote mutations.
