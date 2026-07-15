import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LoopStore } from "../dist/store.js"
import { Scheduler } from "../dist/scheduler.js"
import { CronParser } from "../dist/cron-parser.js"
import { Jitter } from "../dist/jitter.js"

function makeScheduler(logger) {
  const dir = mkdtempSync(join(tmpdir(), "loop-sched-"))
  const store = new LoopStore({ storageDir: dir })
  const sched = new Scheduler({
    store,
    cron: new CronParser(),
    jitter: new Jitter(0.1),
    adaptiveMinMs: 60_000,
    adaptiveMaxMs: 3_600_000,
    logger,
  })
  return { sched, store, dir }
}

test("/loop 5m <prompt> → fixed mode", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("5m check deploy", "/tmp", "s1")
    assert.match(r.message, /Loop started/)
    assert.match(r.message, /5m/)
    assert.equal(r.task.mode, "fixed")
    assert.equal(r.task.intervalMs, 300_000)
    assert.equal(r.task.prompt, "check deploy")
    assert.equal(r.task.sessionID, "s1")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop <prompt> → adaptive mode", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("check the deploy", "/tmp", "s1")
    assert.match(r.message, /adaptive/)
    assert.equal(r.task.mode, "adaptive")
    assert.equal(r.task.intervalMs, undefined)
    assert.equal(r.task.adaptiveMinMs, 60_000)
    assert.equal(r.task.adaptiveMaxMs, 3_600_000)
    assert.equal(r.task.sessionID, "s1")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop (bare) → maintenance mode with adaptiveMaxMs set", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("", "/tmp", "s1")
    assert.match(r.message, /maintenance/)
    assert.equal(r.task.mode, "maintenance")
    assert.match(r.task.prompt, /Continue any unfinished work/)
    assert.equal(r.task.adaptiveMaxMs, 3_600_000, "maintenance has adaptiveMaxMs for re-arm")
    assert.equal(r.task.sessionID, "s1")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop without sessionID is rejected", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("5m test", "/tmp")
    assert.match(r.message, /active session/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("scheduler clamps adaptive ms within bounds", () => {
  const { sched } = makeScheduler()
  assert.equal(sched.clampAdaptive(10_000), 60_000)
  assert.equal(sched.clampAdaptive(10_000_000), 3_600_000)
  assert.equal(sched.clampAdaptive(180_000), 180_000)
})

test("scheduler rearmFixed sets next due based on interval + jitter", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("5m test", "/tmp", "s1")
    const task = r.task
    const before = Date.now()
    await sched.rearmFixed(task, before)
    // nextDueAt should be ≈ before + 5min (jitter ±interval/2)
    assert.ok(task.nextDueAt >= before + 300_000 - 150_000, `nextDueAt ${task.nextDueAt} too low`)
    assert.ok(task.nextDueAt <= before + 300_000 + 150_000, `nextDueAt ${task.nextDueAt} too high`)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("nextDueAt: fixed → interval + jitter", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const t = await store.create({ prompt: "f", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "s1" })
    for (let i = 0; i < 30; i++) {
      const now = Date.now()
      const nd = await sched.nextDueAt(t, now)
      const diff = nd - now
      // For 60s interval: jitter ∈ {-60000, +60000} → diff ∈ {0, 120000}
      assert.ok(diff >= 0 && diff <= 120_000, `diff ${diff} out of [0, 120000]`)
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("nextDueAt: maintenance → adaptiveMaxMs", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const t = await store.create({ prompt: "m", mode: "maintenance", adaptiveMaxMs: 3_600_000, directory: "/tmp", sessionID: "s1" })
    const now = Date.now()
    const nd = await sched.nextDueAt(t, now)
    assert.equal(nd, now + 3_600_000)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop list defaults to current session", async () => {
  const { sched, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand("list", "/tmp", "sA")
    assert.match(r.message, /1 loop task/, "A sees 1 task")
    assert.ok(!r.message.includes("sB"), "A does not see B's session tag (--all not used)")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop list --all shows all sessions with tags", async () => {
  const { sched, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand("list --all", "/tmp", "sA")
    assert.match(r.message, /2 loop task/, "all sees 2")
    assert.match(r.message, /\[s:/, "shows session tags")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop cancel refuses cross-session without --all", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const a = await sched.handleUserCommand("5m in A", "/tmp", "sA")
    const b = await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand(`cancel ${b.task.id}`, "/tmp", "sA")
    assert.match(r.message, /another session/)
    assert.ok(store.get(b.task.id), "B task still exists")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop cancel --all overrides cross-session", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    const b = await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand(`cancel ${b.task.id} --all`, "/tmp", "sA")
    assert.match(r.message, /Cancelled/)
    assert.equal(store.get(b.task.id), null)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop stop-all defaults to current session only", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A1", "/tmp", "sA")
    await sched.handleUserCommand("5m in A2", "/tmp", "sA")
    await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand("stop-all", "/tmp", "sA")
    assert.match(r.message, /2 task/, "removes 2 from A")
    assert.equal(store.listBySession("sA").length, 0)
    assert.equal(store.listBySession("sB").length, 1, "B untouched")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop stop-all --all cancels everything", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand("stop-all --all", "/tmp", "sA")
    assert.match(r.message, /across all sessions/)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop pause refuses cross-session without --all", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const b = await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand(`pause ${b.task.id}`, "/tmp", "sA")
    assert.match(r.message, /another session/)
    assert.equal(store.get(b.task.id).paused, false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop resume --all works cross-session and rearms fixed", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const b = await sched.handleUserCommand("5m in B", "/tmp", "sB")
    await store.setPaused(b.task.id, true)
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand(`resume ${b.task.id} --all`, "/tmp", "sA")
    assert.match(r.message, /Resumed/)
    assert.equal(store.get(b.task.id).paused, false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("fireTask failure uses structured logger without console output", async () => {
  const logCalls = []
  const consoleCalls = []
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = (...args) => consoleCalls.push(["log", ...args])
  console.warn = (...args) => consoleCalls.push(["warn", ...args])
  console.error = (...args) => consoleCalls.push(["error", ...args])
  const { sched, dir } = makeScheduler(async (level, message, extra) => {
    logCalls.push({ level, message, extra })
  })
  try {
    const result = await sched.handleUserCommand("5m fail", dir, "s1")
    const client = {
      session: {
        async prompt() {
          throw new Error("prompt failed")
        },
      },
    }

    await sched.fireTask(result.task, { client, directory: dir })

    assert.equal(consoleCalls.length, 0)
    assert.equal(logCalls.length, 1)
    assert.equal(logCalls[0].level, "error")
    assert.match(logCalls[0].message, /failed to fire task/i)
    assert.equal(logCalls[0].extra.taskId, result.task.id)
    assert.equal(logCalls[0].extra.error, "prompt failed")
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    rmSync(dir, { recursive: true })
  }
})
