import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
)
const tsconfig = JSON.parse(
  await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
)
const builtDialogView = await readFile(
  new URL("../dist/tui-dialog-view.js", import.meta.url),
  "utf8",
)

test("publishes the 0.4.0 fixes release", () => {
  assert.equal(packageJson.version, "0.4.0")
})

test("publishes explicit server and TUI plugin entrypoints", () => {
  assert.deepEqual(packageJson.exports["./server"], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  })
  assert.deepEqual(packageJson.exports["./tui"], {
    types: "./dist/tui.d.ts",
    import: "./dist/tui.js",
  })
})

test("keeps the root server entrypoint for backward compatibility", () => {
  assert.deepEqual(packageJson.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  })
})

test("declares the minimum OpenCode version required by the TUI API", () => {
  assert.equal(packageJson.engines.opencode, ">=1.17.18")
  assert.equal(packageJson.peerDependencies["@opencode-ai/plugin"], ">=1.17.18")
})

test("pins the clipboard runtime used by the published TUI companion", () => {
  assert.equal(packageJson.dependencies.clipboardy, "4.0.0")
})

test("declares the host TUI peers used by the responsive dialog", () => {
  assert.equal(packageJson.peerDependencies["@opentui/core"], ">=0.4.3")
  assert.equal(packageJson.peerDependencies["@opentui/solid"], ">=0.4.3")
  assert.equal(packageJson.peerDependencies["solid-js"], "1.9.12")
})

test("test command always builds fresh output before running tests", () => {
  assert.match(packageJson.scripts.test, /^npm run build && /)
})

test("preserves TSX for the OpenTUI Solid compiler", () => {
  assert.equal(tsconfig.compilerOptions.jsx, "preserve")
})

test("builds JavaScript through the Solid-aware build script", () => {
  assert.equal(packageJson.scripts.build, "node scripts/build.mjs")
})

test("emits reactive Solid updates for selected dialog rows", () => {
  assert.doesNotMatch(builtDialogView, /@opentui\/solid\/jsx-runtime/)
  assert.match(
    builtDialogView,
    /import \{ effect as \S+ \} from ["']@opentui\/solid["']/,
  )
  assert.match(
    builtDialogView,
    /setProp\([^\n]+["']backgroundColor["'][^\n]+\)/,
  )
})
