import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
)

test("publishes the 0.7.1 release", () => {
  assert.equal(packageJson.version, "0.7.1")
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

test("declares the minimum OpenCode version required by the plugin API", () => {
  assert.equal(packageJson.engines.opencode, ">=1.17.18")
  assert.equal(packageJson.peerDependencies["@opencode-ai/plugin"], ">=1.17.18")
})

test("ships no dialog runtime dependencies", () => {
  assert.equal(packageJson.dependencies, undefined)
  assert.equal(packageJson.peerDependencies["@opentui/core"], undefined)
  assert.equal(packageJson.peerDependencies["@opentui/solid"], undefined)
  assert.equal(packageJson.peerDependencies["solid-js"], undefined)
})

test("test command always builds fresh output before running tests", () => {
  assert.match(packageJson.scripts.test, /^npm run build && /)
})
