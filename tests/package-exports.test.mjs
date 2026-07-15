import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
)

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

test("test command always builds fresh output before running tests", () => {
  assert.match(packageJson.scripts.test, /^npm run build && /)
})
