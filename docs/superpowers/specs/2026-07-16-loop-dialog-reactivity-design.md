# Loop dialog reactivity design

## Context

OpenCode 1.17.18 displays the Loop result dialog and highlights `Copy ID` initially, but pressing `Up`, `Down`, or `Tab` does not visibly move the highlight. Instrumentation in a real local OpenCode process showed that the renderer emits the `down` key, the mounted `LoopFeedbackDialog` receives it, and the selected action signal changes from index `0` to index `1`. The interaction controller is therefore working; the rendered attributes are not reacting to signal changes.

The package currently compiles TSX directly with TypeScript using `jsx: react-jsx`. The resulting `dist/tui-dialog-view.js` evaluates expressions such as `active() ? theme.primary : transparent` once while creating the element. OpenTUI Solid requires preserved JSX followed by the Solid universal transform, which generates subscriptions for reactive attributes. Because that transform is missing, the dialog renders its initial state but freezes its highlight, responsive dimensions, and other signal-backed properties.

## Goals

- Compile OpenTUI Solid TSX with the Solid universal transform.
- Make keyboard and pointer selection changes visibly update the action highlight.
- Preserve the existing Node/npm development and publishing workflow.
- Preserve TypeScript declarations and all current package exports.
- Add regression coverage that fails if TSX is again emitted through the non-reactive JSX runtime.
- Validate the packed package in the real local OpenCode TUI.

## Non-goals

- Changing the dialog layout, action labels, keyboard mappings, or copy-close behavior.
- Replacing the custom responsive dialog with OpenCode's `DialogSelect`.
- Changing scheduler, task persistence, `/loop` syntax, or OpenCode configuration.
- Publishing to GitHub or npm as part of this local-fix task unless separately requested.

## Chosen approach

Keep the project on Node and npm, but replace the JavaScript-emission portion of `tsc` with a small Node build script backed by Babel:

1. Set TypeScript JSX handling to `preserve` so TypeScript never lowers TSX through `@opentui/solid/jsx-runtime`.
2. Run TypeScript in declaration-only mode to preserve the existing `.d.ts` outputs and strict type checking.
3. Transform source `.ts` and `.tsx` files with `@babel/preset-typescript`.
4. For `.tsx`, also apply `babel-preset-solid` with `moduleName: "@opentui/solid"` and `generate: "universal"`, matching OpenTUI Solid's documented transform.
5. Preserve the source directory structure and current `.js` import specifiers in `dist`.

The build dependencies will be declared directly in `devDependencies` rather than relying on transitive packages from OpenTUI.

## Alternatives considered

### Bun build plugin

`@opentui/solid` ships a Bun plugin that applies the same transform. It is an official route, but adopting it would add Bun as a build-time requirement to a package whose existing installation, testing, and publishing flow is Node/npm based.

### Imperative renderable updates

The component could keep references to the three action rows and set colors manually whenever selection changes. This would only mask the visible highlight bug. Responsive sizes and any future reactive JSX attributes would remain frozen, creating more one-off update code and leaving the invalid build pipeline in place.

## Build and error handling

The build script will remove stale `dist` output, generate declarations, transform every supported source file, and fail immediately on type-check or transform errors. It will not silently retain a partially old build. The existing `prepare`, `test`, and `prepublishOnly` entry points will continue to call `npm run build`.

## Testing

Tests will be added before the build change and must initially fail against the current pipeline. Regression coverage will verify:

- `tsconfig.json` preserves JSX.
- the build command uses the Solid-aware build script;
- built TSX does not import `@opentui/solid/jsx-runtime`;
- the compiled selected-state styling contains Solid-generated reactive update machinery instead of a one-time conditional property;
- package exports and declaration files remain present;
- all existing interaction and plugin tests still pass.

Because OpenTUI's native test renderer is unavailable under the repository's Node runtime on this machine, final behavior will also be verified in an actual OpenCode PTY using the packed local package. The check will open the Loop dialog, exercise `Down`, `Up`, `Tab`, pointer selection, and activation, and confirm that the visible highlight follows the selected action.

## Local installation cleanup

The diagnostic cache instrumentation used to identify the fault has already been removed. After implementation, both unversioned and `@latest` plugin caches will be removed, the fixed packed artifact will be installed locally, and the installed files will be checked to ensure they match the new reactive build rather than stale version `0.2.8` output.
