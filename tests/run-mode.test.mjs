/**
 * Run-mode fallback tests (issue #18).
 *
 * `opencode run "/loop ..."` (headless and -i) sends the literal command text
 * as a plain user message via session.prompt, so command.execute.before is
 * never emitted. The plugin intercepts the literal `/loop ...` text in the
 * chat.message hook and runs the same deterministic parser, so the documented
 * guards (missing prompt, cron rejection, unknown flags, canonical help)
 * apply in every mode.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const pluginModule = await import("../dist/index.js")

async function makeHooks(dir) {
  return pluginModule.LoopPlugin({
    client: {},
    project: { id: "test" },
    directory: dir,
    worktree: dir,
    $: {},
    serverUrl: new URL("http://localhost:3000"),
    experimental_workspace: { register: () => {} },
  })
}

function textMessage(text, sessionID = "sRun") {
  return {
    message: { id: "m1", sessionID, role: "user", time: { created: Date.now() } },
    parts: [{ id: "p1", sessionID, messageID: "m1", type: "text", text }],
  }
}

function tasksFile(dir) {
  return join(dir, ".opencode/cache/loop/tasks.json")
}

function taskCount(dir) {
  return existsSync(tasksFile(dir))
    ? JSON.parse(readFileSync(tasksFile(dir), "utf-8")).tasks.length
    : 0
}

test("run mode: '/loop 5m' returns missing-prompt error and creates nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    const out = textMessage("/loop 5m")
    await hooks["chat.message"]({ sessionID: "sRun" }, out)
    assert.equal(out.parts[0].synthetic, true, "command text consumed")
    assert.ok(
      out.parts[0].text.includes('Missing prompt after interval "5m"'),
      `expected missing-prompt failure, got: ${out.parts[0].text.slice(0, 120)}`
    )
    assert.equal(taskCount(dir), 0, "no task created")
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run mode: cron expression is rejected deterministically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    const out = textMessage("/loop */5 * * * * check something")
    await hooks["chat.message"]({ sessionID: "sRun" }, out)
    assert.ok(
      out.parts[0].text.includes("Cron expressions are not supported"),
      `expected cron rejection, got: ${out.parts[0].text.slice(0, 120)}`
    )
    assert.equal(taskCount(dir), 0, "no task created")
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run mode: unknown flag is rejected deterministically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    const out = textMessage("/loop --bogus do something")
    await hooks["chat.message"]({ sessionID: "sRun" }, out)
    assert.ok(
      out.parts[0].text.includes('Unknown flag "--bogus"'),
      `expected unknown-flag rejection, got: ${out.parts[0].text.slice(0, 120)}`
    )
    assert.equal(taskCount(dir), 0, "no task created")
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run mode: '/loop help' yields the canonical LOOP_HELP text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    const out = textMessage("/loop help")
    await hooks["chat.message"]({ sessionID: "sRun" }, out)
    assert.equal(out.parts[0].synthetic, true)
    assert.ok(out.parts[0].text.includes("run prompts on a schedule"))
    assert.ok(out.parts[0].text.includes("/loop cancel"))
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run mode: valid fixed interval creates a fixed task bound to the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    const out = textMessage("/loop 1m ping the server")
    await hooks["chat.message"]({ sessionID: "sRun" }, out)
    assert.equal(taskCount(dir), 1, "one task created")
    const task = JSON.parse(readFileSync(tasksFile(dir), "utf-8")).tasks[0]
    assert.equal(task.mode, "fixed")
    assert.equal(task.intervalMs, 60_000)
    assert.equal(task.prompt, "ping the server")
    assert.equal(task.sessionID, "sRun")
    assert.equal(out.parts[0].synthetic, true, "confirmation replaces command text")
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run mode: bare '/loop' starts maintenance mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    const out = textMessage("/loop")
    await hooks["chat.message"]({ sessionID: "sRun" }, out)
    assert.equal(taskCount(dir), 1)
    const task = JSON.parse(readFileSync(tasksFile(dir), "utf-8")).tasks[0]
    assert.equal(task.mode, "maintenance")
    assert.equal(out.parts[0].synthetic, true)
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run mode: regular messages and mere mentions of /loop are untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    for (const text of [
      "hello there",
      "please explain what /loop 5m does",
      "/loops are great",
      "/loopx not a command",
    ]) {
      const out = textMessage(text)
      await hooks["chat.message"]({ sessionID: "sRun" }, out)
      assert.equal(out.parts[0].text, text, `message untouched: ${text}`)
      assert.notEqual(out.parts[0].synthetic, true)
    }
    assert.equal(taskCount(dir), 0)
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("no double handling: command.execute.before consumption is skipped by chat.message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    // TUI path: command.execute.before consumes the parts first...
    const output = { parts: [{ id: "p1", sessionID: "sT", messageID: "m1", type: "text", text: "1m ping" }] }
    await hooks["command.execute.before"](
      { command: "loop", arguments: "1m ping", sessionID: "sT" },
      output
    )
    assert.equal(taskCount(dir), 1)
    // ...then chat.message fires for the same message and must not re-handle
    await hooks["chat.message"]({ sessionID: "sT" }, output)
    assert.equal(taskCount(dir), 1, "still exactly one task")
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("chat.message without output argument still tracks the active session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-run-"))
  try {
    const hooks = await makeHooks(dir)
    await hooks["chat.message"]({ sessionID: "sB" })
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
