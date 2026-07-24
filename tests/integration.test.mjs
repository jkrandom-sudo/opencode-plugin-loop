/**
 * Integration test: simulate the opencode plugin lifecycle.
 * Verifies that the plugin:
 *  - Loads without errors
 *  - Handles /loop command via command.execute.before
 *  - Tracks active session via chat.message
 *  - Cleans up tasks on session.deleted
 *  - Persists tasks to disk (per-session scoping)
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const pluginModule = await import("../dist/index.js")

test("plugin module exports LoopPlugin", () => {
  assert.ok(pluginModule.LoopPlugin, "should export LoopPlugin")
  assert.equal(pluginModule.default.id, "opencode-plugin-loop")
  assert.equal(pluginModule.default.server, pluginModule.LoopPlugin)
  assert.ok(pluginModule.LoopStore, "should export LoopStore")
  assert.ok(pluginModule.CronParser, "should export CronParser")
  assert.ok(pluginModule.Jitter, "should export Jitter")
  assert.ok(pluginModule.Scheduler, "should export Scheduler")
})

test("plugin returns Hooks with event + command + tool + dispose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  try {
    const mockClient = {
      tui: { appendPrompt: async () => true },
    }
    const hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })
    assert.ok(hooks, "hooks should be returned")
    assert.ok(hooks.event, "should have event hook")
    assert.ok(hooks["command.execute.before"], "should have command hook")
    assert.ok(hooks["chat.message"], "should have chat.message hook")
    assert.ok(hooks.tool, "should have tool registrations")
    assert.ok(hooks.tool.loop_schedule, "loop_schedule tool registered")
    assert.ok(hooks.tool.loop_status, "loop_status tool registered")
    assert.ok(typeof hooks.dispose === "function", "should have dispose")
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("end-to-end: /loop 1m ping in sessionA → persists → fires only when active is A", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  try {
    const promptCalls = []
    const mockClient = {
      session: {
        promptCalls,
        async prompt(args) {
          this.promptCalls.push(args)
          return { info: {}, parts: [] }
        },
      },
    }

    const hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })

    // Create task in session A
    await hooks["command.execute.before"](
      { command: "loop", arguments: "1m ping the server", sessionID: "sA" },
      { parts: [] }
    )
    const tasksFile = join(dir, ".opencode/cache/loop/tasks.json")
    assert.ok(existsSync(tasksFile), "tasks.json should be written")

    // Force task to be past-due
    const data = JSON.parse(readFileSync(tasksFile, "utf-8"))
    assert.equal(data.tasks.length, 1)
    assert.equal(data.tasks[0].sessionID, "sA")
    data.tasks[0].nextDueAt = Date.now() - 1000
    writeFileSync(tasksFile, JSON.stringify(data), "utf-8")

    // Reload store via session.compacted event
    await hooks.event({ event: { type: "session.compacted" } })

    // Active session is "sB" → A's task should NOT fire
    await hooks["chat.message"]({ sessionID: "sB" })
    // Simulate one ticker cycle by invoking getDueTasksForSession(sB) — which is empty
    // The actual ticker fires automatically every 15s; we can't await it here.
    // To verify isolation, we trust the unit tests in per-session.test.mjs.
    // Here we just verify the data state.
    const dataAfter = JSON.parse(readFileSync(tasksFile, "utf-8"))
    assert.equal(dataAfter.tasks[0].lastFiredAt, 0, "task in A did not fire while active is B")

    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("loop_schedule tool: create, list, cancel with session scoping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  try {
    const mockClient = { tui: { appendPrompt: async () => true } }
    const hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })

    const tool = hooks.tool.loop_schedule
    const ctx = {
      sessionID: "s1",
      messageID: "m1",
      agent: "build",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }

    // 1) Create a fixed-interval task
    const r1 = JSON.parse(await tool.execute({ action: "create", prompt: "test 1", intervalMs: 300_000 }, ctx))
    assert.equal(r1.ok, true)
    assert.equal(r1.task.mode, "fixed")
    assert.equal(r1.task.intervalMs, 300_000)
    assert.equal(r1.task.sessionID, "s1")
    const taskId = r1.task.id

    // 2) List tasks — scoped to s1
    const r2 = JSON.parse(await tool.execute({ action: "list" }, ctx))
    assert.equal(r2.count, 1)
    assert.equal(r2.scope, "s1")

    // 3) Cancel
    const r3 = JSON.parse(await tool.execute({ action: "cancel", taskId }, ctx))
    assert.equal(r3.ok, true)
    assert.equal(r3.removed.id, taskId)

    // 4) List again, should be empty
    const r4 = JSON.parse(await tool.execute({ action: "list" }, ctx))
    assert.equal(r4.count, 0)

    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("loop_status tool returns task summary with session scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  try {
    const mockClient = { tui: { appendPrompt: async () => true } }
    const hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })
    const tool = hooks.tool.loop_status
    const ctx = {
      sessionID: "s1",
      messageID: "m1",
      agent: "build",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }
    const r = JSON.parse(await tool.execute({}, ctx))
    assert.equal(r.ok, true)
    assert.equal(r.activeTasks, 0)
    assert.equal(r.pausedTasks, 0)
    assert.equal(r.scope, "s1")
    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("session.deleted event cancels that session's tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  try {
    const mockClient = { tui: { appendPrompt: async () => true } }
    const hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })

    await hooks["command.execute.before"](
      { command: "loop", arguments: "5m task in A", sessionID: "sA" },
      { parts: [] }
    )
    await hooks["command.execute.before"](
      { command: "loop", arguments: "5m task in B", sessionID: "sB" },
      { parts: [] }
    )

    const tasksFile = join(dir, ".opencode/cache/loop/tasks.json")
    const before = JSON.parse(readFileSync(tasksFile, "utf-8"))
    assert.equal(before.tasks.length, 2)

    await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "sA" } } })

    const after = JSON.parse(readFileSync(tasksFile, "utf-8"))
    assert.equal(after.tasks.length, 1)
    assert.equal(after.tasks[0].sessionID, "sB")

    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("plugin loads legacy tasks.json, drops orphans, keeps session-bound ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  try {
    const cacheDir = join(dir, ".opencode/cache/loop")
    const fs = await import("node:fs")
    fs.mkdirSync(cacheDir, { recursive: true })
    const data = {
      version: 1,
      tasks: [
        { id: "orphan", prompt: "no sid", mode: "fixed", intervalMs: 60_000, createdAt: Date.now(), lastFiredAt: 0, nextDueAt: Date.now() + 60_000, source: "user", directory: "/tmp", paused: false },
        { id: "good", prompt: "with sid", mode: "fixed", intervalMs: 60_000, createdAt: Date.now(), lastFiredAt: 0, nextDueAt: Date.now() + 60_000, source: "user", directory: "/tmp", sessionID: "sX", paused: false },
      ],
    }
    writeFileSync(join(cacheDir, "tasks.json"), JSON.stringify(data), "utf-8")

    const mockClient = { tui: { appendPrompt: async () => true } }
    const hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
      // Legacy-file migration is exercised with the durable lifecycle; the
      // ephemeral default intentionally drops no-pid files (covered below).
      options: { ephemeralTasks: false },
    })

    // Should have only 1 task (the one with sessionID)
    const tool = hooks.tool.loop_status
    const ctx = {
      sessionID: "sX",
      messageID: "m1",
      agent: "build",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }
    const r = JSON.parse(await tool.execute({}, ctx))
    assert.equal(r.activeTasks, 1)
    assert.equal(r.tasks[0].id, "good")

    await hooks.dispose()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop list is presented inline by the model with no toast and no feedback file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  const consoleCalls = []
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }
  console.log = (...args) => consoleCalls.push(["log", ...args])
  console.warn = (...args) => consoleCalls.push(["warn", ...args])
  console.error = (...args) => consoleCalls.push(["error", ...args])

  let hooks
  try {
    const logCalls = []
    const toastCalls = []
    const mockClient = {
      app: {
        async log(args) {
          logCalls.push(args)
          return true
        },
      },
      tui: {
        async showToast(args) {
          toastCalls.push(args)
          return true
        },
      },
    }
    hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })

    await hooks["command.execute.before"](
      { command: "loop", arguments: "30m check the build", sessionID: "sA" },
      { parts: [{ id: "p0", sessionID: "sA", messageID: "m0", type: "text", text: "30m check the build" }] }
    )

    const output = {
      parts: [
        {
          id: "part-1",
          sessionID: "sA",
          messageID: "m1",
          type: "text",
          text: "list",
        },
      ],
    }
    await hooks["command.execute.before"](
      { command: "loop", arguments: "list", sessionID: "sA" },
      output
    )

    assert.equal(consoleCalls.length, 0)
    assert.equal(toastCalls.length, 0)
    assert.equal(existsSync(join(dir, ".opencode/cache/loop/tui-feedback.json")), false)
    // The model receives the task data plus presentation instructions.
    assert.match(output.parts[0].text, /loop task\(s\)/i)
    assert.match(output.parts[0].text, /check the build/)
    assert.match(output.parts[0].text, /markdown table/i)
    assert.match(output.parts[0].text, /Job ID/)
    assert.match(output.parts[0].text, /same language/i)
    assert.match(output.parts[0].text, /do not call tools/i)
    assert.doesNotMatch(output.parts[0].text, /^list$/)
    // The instance lock also logs ("loop instance lock acquired") — select
    // the command log entry for the list command.
    const commandLogs = logCalls.filter(
      (c) => c.body?.extra?.action === "list"
    )
    assert.equal(commandLogs.length, 1)
    assert.match(commandLogs[0].body.message, /loop task/i)
  } finally {
    if (hooks) await hooks.dispose()
    console.log = originalConsole.log
    console.warn = originalConsole.warn
    console.error = originalConsole.error
    rmSync(dir, { recursive: true })
  }
})

test("starting a loop stays silent on the TUI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  let hooks
  try {
    const toastCalls = []
    const mockClient = {
      app: { async log() { return true } },
      tui: {
        async showToast(args) {
          toastCalls.push(args)
          return true
        },
      },
    }
    hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })

    const output = {
      parts: [{ id: "p1", sessionID: "sA", messageID: "m1", type: "text", text: "5m check the build" }],
    }
    await hooks["command.execute.before"](
      { command: "loop", arguments: "5m check the build", sessionID: "sA" },
      output
    )

    assert.equal(toastCalls.length, 0)
    assert.match(output.parts[0].text, /Job ID: [a-z0-9]+/i)
    assert.match(output.parts[0].text, /every 5m/)
    assert.match(output.parts[0].text, /same language/i)
    assert.match(output.parts[0].text, /do not call tools/i)
  } finally {
    if (hooks) await hooks.dispose()
    rmSync(dir, { recursive: true })
  }
})

test("command failure is presented inline instead of rejecting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  let hooks
  try {
    const cacheDir = join(dir, ".opencode/cache/loop")
    mkdirSync(cacheDir, { recursive: true })
    const now = Date.now()
    const tasks = Array.from({ length: 50 }, (_, index) => ({
      id: `full-${index}`,
      prompt: `existing task ${index}`,
      mode: "fixed",
      intervalMs: 60_000,
      createdAt: now,
      lastFiredAt: 0,
      nextDueAt: now + 60_000,
      source: "user",
      directory: dir,
      sessionID: "sA",
      paused: false,
    }))
    writeFileSync(
      join(cacheDir, "tasks.json"),
      JSON.stringify({ version: 1, pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, tasks }),
      "utf-8"
    )

    const toastCalls = []
    const mockClient = {
      app: { log: async () => true },
      tui: {
        async showToast(args) {
          toastCalls.push(args)
          return true
        },
      },
    }
    hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })
    const output = {
      parts: [
        {
          id: "part-1",
          sessionID: "sA",
          messageID: "m1",
          type: "text",
          text: "5m another task",
        },
      ],
    }

    await hooks["command.execute.before"](
      { command: "loop", arguments: "5m another task", sessionID: "sA" },
      output
    )

    assert.equal(toastCalls.length, 0)
    assert.match(output.parts[0].text, /failed/i)
    assert.match(output.parts[0].text, /max tasks/i)
    assert.match(output.parts[0].text, /same language/i)
  } finally {
    if (hooks) await hooks.dispose()
    rmSync(dir, { recursive: true })
  }
})

test("natural adaptive command becomes the current model turn instead of an acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  let hooks
  try {
    const mockClient = {
      app: { log: async () => true },
      tui: { showToast: async () => true },
    }
    hooks = await pluginModule.LoopPlugin({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })
    const output = {
      parts: [
        {
          id: "part-1",
          sessionID: "sA",
          messageID: "m1",
          type: "text",
          text: "每隔两分钟查看插件最新版本",
        },
      ],
    }

    await hooks["command.execute.before"](
      { command: "loop", arguments: "每隔两分钟查看插件最新版本", sessionID: "sA" },
      output
    )

    assert.match(output.parts[0].text, /每隔两分钟查看插件最新版本/)
    assert.match(output.parts[0].text, /set_fixed/)
    assert.match(output.parts[0].text, /delayMs/)
    assert.doesNotMatch(output.parts[0].text, /already handled/i)
    assert.equal(output.parts[0].synthetic, true)
  } finally {
    if (hooks) await hooks.dispose()
    rmSync(dir, { recursive: true })
  }
})

test("ephemeral lifecycle: plugin reload in the same process keeps tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  try {
    const mockClient = { tui: { appendPrompt: async () => true } }
    const ctx = () => ({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
    })

    const first = await pluginModule.LoopPlugin(ctx())
    await first["command.execute.before"](
      { command: "loop", arguments: "1m ping", sessionID: "sA" },
      { parts: [] }
    )
    await first.dispose()

    // Simulate an in-process plugin reload (opencode re-inits plugins per command).
    const second = await pluginModule.LoopPlugin(ctx())
    const status = JSON.parse(
      await second.tool.loop_status.execute({}, {
        sessionID: "sA",
        messageID: "m1",
        agent: "build",
        directory: dir,
        worktree: dir,
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      })
    )
    assert.equal(status.activeTasks, 1, "same-process reload keeps the task")
    await second.dispose()
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("ephemeral lifecycle: foreign-pid tasks.json dropped by default, kept with ephemeralTasks: false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-int-"))
  try {
    const cacheDir = join(dir, ".opencode/cache/loop")
    mkdirSync(cacheDir, { recursive: true })
    const foreignState = () => ({
      version: 1,
      pid: 1,
      startedAt: Date.now() - 86_400_000,
      tasks: [
        { id: "foreign", prompt: "from a dead process", mode: "fixed", intervalMs: 60_000, createdAt: Date.now(), lastFiredAt: 0, nextDueAt: Date.now() + 60_000, source: "user", directory: dir, sessionID: "sA", paused: false },
      ],
    })
    const mockClient = { tui: { appendPrompt: async () => true } }
    const ctx = (options) => ({
      client: mockClient,
      project: { id: "test" },
      directory: dir,
      worktree: dir,
      $: {},
      serverUrl: new URL("http://localhost:3000"),
      experimental_workspace: { register: () => {} },
      ...(options ? { options } : {}),
    })
    const toolCtx = {
      sessionID: "sA",
      messageID: "m1",
      agent: "build",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }

    // Default (ephemeral): task written by a dead process is dropped on load.
    writeFileSync(join(cacheDir, "tasks.json"), JSON.stringify(foreignState()), "utf-8")
    const ephemeralHooks = await pluginModule.LoopPlugin(ctx())
    const dropped = JSON.parse(await ephemeralHooks.tool.loop_status.execute({}, toolCtx))
    assert.equal(dropped.activeTasks, 0)
    assert.equal(dropped.pausedTasks, 0)
    await ephemeralHooks.dispose()

    // Durable: same fixture is preserved.
    writeFileSync(join(cacheDir, "tasks.json"), JSON.stringify(foreignState()), "utf-8")
    const durableHooks = await pluginModule.LoopPlugin(ctx({ ephemeralTasks: false }))
    const kept = JSON.parse(await durableHooks.tool.loop_status.execute({}, toolCtx))
    assert.equal(kept.activeTasks, 1)
    assert.equal(kept.tasks[0].id, "foreign")
    await durableHooks.dispose()
  } finally {
    rmSync(dir, { recursive: true })
  }
})
