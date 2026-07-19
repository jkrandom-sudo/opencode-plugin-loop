import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LoopStore } from "../dist/store.js"

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  const store = new LoopStore({ storageDir: dir, maxTasks: 5, taskTtlMs: 60_000 })
  return { store, dir }
}

// Fixtures written by hand must carry the current process identity so the
// ephemeral-lifecycle check (default on) treats them as same-process writes.
const currentProcess = () => ({ pid: process.pid, startedAt: Date.now() - process.uptime() * 1000 })

test("create + list task", async () => {
  const { store, dir } = makeStore()
  try {
    const t = await store.create({
      prompt: "test",
      mode: "fixed",
      intervalMs: 300_000,
      directory: "/tmp",
      sessionID: "s1",
    })
    assert.ok(t.id)
    assert.equal(t.prompt, "test")
    assert.equal(t.sessionID, "s1")
    assert.equal(store.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("create requires sessionID", async () => {
  const { store, dir } = makeStore()
  try {
    await assert.rejects(
      () =>
        store.create({
          prompt: "x",
          mode: "fixed",
          intervalMs: 60_000,
          directory: "/tmp",
        }),
      /sessionID is required/
    )
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("cancel task", async () => {
  const { store, dir } = makeStore()
  try {
    const t = await store.create({
      prompt: "x",
      mode: "fixed",
      intervalMs: 60_000,
      directory: "/tmp",
      sessionID: "s1",
    })
    const removed = await store.cancel(t.id)
    assert.ok(removed)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("max tasks enforced", async () => {
  const { store, dir } = makeStore()
  try {
    for (let i = 0; i < 5; i++) {
      await store.create({
        prompt: `t${i}`,
        mode: "fixed",
        intervalMs: 60_000,
        directory: "/tmp",
        sessionID: "s1",
      })
    }
    await assert.rejects(
      () =>
        store.create({
          prompt: "overflow",
          mode: "fixed",
          intervalMs: 60_000,
          directory: "/tmp",
          sessionID: "s1",
        }),
      /Max tasks/
    )
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("persistence round-trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const s1 = new LoopStore({ storageDir: dir })
    await s1.load()
    const t = await s1.create({
      prompt: "persist",
      mode: "fixed",
      intervalMs: 60_000,
      directory: "/tmp",
      sessionID: "s1",
    })

    const s2 = new LoopStore({ storageDir: dir })
    await s2.load()
    assert.equal(s2.list().length, 1)
    assert.equal(s2.get(t.id)?.prompt, "persist")
    assert.equal(s2.get(t.id)?.sessionID, "s1")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("expired tasks filtered on load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const data = {
      version: 1,
      ...currentProcess(),
      tasks: [
        {
          id: "expired1",
          prompt: "expired task",
          mode: "fixed",
          intervalMs: 60_000,
          createdAt: Date.now() - 5000,
          lastFiredAt: 0,
          nextDueAt: Date.now() + 60_000,
          source: "user",
          directory: "/tmp",
          sessionID: "s1",
          paused: false,
        },
        {
          id: "fresh1",
          prompt: "fresh task",
          mode: "fixed",
          intervalMs: 60_000,
          createdAt: Date.now(),
          lastFiredAt: 0,
          nextDueAt: Date.now() + 60_000,
          source: "user",
          directory: "/tmp",
          sessionID: "s1",
          paused: false,
        },
      ],
    }
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(data), "utf-8")

    const s = new LoopStore({ storageDir: dir, taskTtlMs: 1000 })
    await s.load()
    assert.equal(s.list().length, 1, "only the fresh task should survive")
    assert.equal(s.list()[0].id, "fresh1")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("orphan tasks (no sessionID) are dropped on load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const data = {
      version: 1,
      ...currentProcess(),
      tasks: [
        // Legacy task without sessionID
        {
          id: "orphan1",
          prompt: "no sid",
          mode: "fixed",
          intervalMs: 60_000,
          createdAt: Date.now(),
          lastFiredAt: 0,
          nextDueAt: Date.now() + 60_000,
          source: "user",
          directory: "/tmp",
          paused: false,
        },
        // Modern task with sessionID
        {
          id: "good1",
          prompt: "has sid",
          mode: "fixed",
          intervalMs: 60_000,
          createdAt: Date.now(),
          lastFiredAt: 0,
          nextDueAt: Date.now() + 60_000,
          source: "user",
          directory: "/tmp",
          sessionID: "s1",
          paused: false,
        },
      ],
    }
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(data), "utf-8")

    const s = new LoopStore({ storageDir: dir })
    await s.load()
    assert.equal(s.list().length, 1, "orphan dropped, good kept")
    assert.equal(s.list()[0].id, "good1")
    assert.equal(s.getOrphanedTasks().length, 0, "no orphans remain")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("getDueTasks respects paused flag", async () => {
  const { store, dir } = makeStore()
  try {
    const t = await store.create({
      prompt: "p",
      mode: "fixed",
      intervalMs: 60_000,
      directory: "/tmp",
      sessionID: "s1",
    })
    await store.reschedule(t.id, Date.now() - 1000)
    let due = await store.getDueTasks()
    assert.equal(due.length, 1)

    await store.setPaused(t.id, true)
    due = await store.getDueTasks()
    assert.equal(due.length, 0)

    await store.setPaused(t.id, false)
    due = await store.getDueTasks()
    assert.equal(due.length, 1)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("listBySession filters correctly", async () => {
  const { store, dir } = makeStore()
  try {
    await store.create({ prompt: "a1", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    await store.create({ prompt: "a2", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    await store.create({ prompt: "b1", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sB" })
    assert.equal(store.listBySession("sA").length, 2)
    assert.equal(store.listBySession("sB").length, 1)
    assert.equal(store.listBySession("nonexistent").length, 0)
    assert.equal(store.listBySession("").length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("getDueTasksForSession filters by session", async () => {
  const { store, dir } = makeStore()
  try {
    const a = await store.create({ prompt: "a", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    await store.create({ prompt: "b", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sB" })
    await store.reschedule(a.id, Date.now() - 1000)
    const dueA = await store.getDueTasksForSession("sA")
    const dueB = await store.getDueTasksForSession("sB")
    assert.equal(dueA.length, 1, "A has due task")
    assert.equal(dueA[0].sessionID, "sA")
    assert.equal(dueB.length, 0, "B has no due tasks")
    assert.equal((await store.getDueTasksForSession("")).length, 0, "no session = empty")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("cancelBySession removes only that session's tasks", async () => {
  const { store, dir } = makeStore()
  try {
    await store.create({ prompt: "a", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    await store.create({ prompt: "b", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sB" })
    const removed = await store.cancelBySession("sA")
    assert.equal(removed, 1)
    assert.equal(store.list().length, 1)
    assert.equal(store.list()[0].sessionID, "sB")
    // No-op for unknown session
    const removed2 = await store.cancelBySession("sUnknown")
    assert.equal(removed2, 0)
    // No-op for empty sessionID
    const removed3 = await store.cancelBySession("")
    assert.equal(removed3, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("markFired handles maintenance mode (auto re-arm)", async () => {
  const { store, dir } = makeStore()
  try {
    const t = await store.create({
      prompt: "m",
      mode: "maintenance",
      adaptiveMaxMs: 3_600_000,
      directory: "/tmp",
      sessionID: "s1",
    })
    await store.markFired(t.id)
    const after = store.get(t.id)
    // nextDueAt should be ~1 hour after lastFiredAt
    assert.ok(after.lastFiredAt > 0)
    assert.ok(after.nextDueAt > Date.now() + 3_500_000)
    assert.ok(after.nextDueAt < Date.now() + 3_700_000)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("markFired respects explicit nextDueAt", async () => {
  const { store, dir } = makeStore()
  try {
    const t = await store.create({ prompt: "f", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "s1" })
    const explicit = Date.now() + 999_999
    await store.markFired(t.id, explicit)
    assert.equal(store.get(t.id).nextDueAt, explicit)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("create persists an explicit fixed-task jitter policy", async () => {
  const { store, dir } = makeStore()
  try {
    const task = await store.create({
      prompt: "fixed without jitter",
      mode: "fixed",
      intervalMs: 120_000,
      jitterEnabled: false,
      directory: "/tmp",
      sessionID: "s1",
    })

    assert.equal(task.jitterEnabled, false)

    const reloaded = new LoopStore({ storageDir: dir })
    await reloaded.load()
    assert.equal(reloaded.get(task.id).jitterEnabled, false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("setFixed atomically converts an adaptive task", async () => {
  const { store, dir } = makeStore()
  try {
    const task = await store.create({
      prompt: "check version",
      mode: "adaptive",
      adaptiveMinMs: 60_000,
      adaptiveMaxMs: 3_600_000,
      directory: "/tmp",
      sessionID: "s1",
    })

    const converted = await store.setFixed(task.id, 120_000, false, 10_000)

    assert.equal(converted.mode, "fixed")
    assert.equal(converted.intervalMs, 120_000)
    assert.equal(converted.jitterEnabled, false)
    assert.equal(converted.adaptiveMinMs, undefined)
    assert.equal(converted.adaptiveMaxMs, undefined)
    assert.equal(converted.lastFiredAt, 10_000)
    assert.equal(converted.nextDueAt, 130_000)

    const reloaded = new LoopStore({ storageDir: dir })
    await reloaded.load()
    assert.deepEqual(reloaded.get(task.id), converted)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("structured logger records task cleanup without console output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  const consoleCalls = []
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = (...args) => consoleCalls.push(["log", ...args])
  console.warn = (...args) => consoleCalls.push(["warn", ...args])
  console.error = (...args) => consoleCalls.push(["error", ...args])
  try {
    const now = Date.now()
    writeFileSync(
      join(dir, "tasks.json"),
      JSON.stringify({
        version: 1,
        ...currentProcess(),
        tasks: [
          {
            id: "orphan",
            prompt: "legacy",
            mode: "fixed",
            intervalMs: 60_000,
            createdAt: now,
            lastFiredAt: 0,
            nextDueAt: now + 60_000,
            source: "user",
            directory: "/tmp",
            paused: false,
          },
          {
            id: "kept",
            prompt: "modern",
            mode: "fixed",
            intervalMs: 60_000,
            createdAt: now,
            lastFiredAt: 0,
            nextDueAt: now + 60_000,
            source: "user",
            directory: "/tmp",
            sessionID: "s1",
            paused: false,
          },
        ],
      }),
      "utf-8"
    )
    const logCalls = []
    const store = new LoopStore({
      storageDir: dir,
      logger: async (level, message, extra) => logCalls.push({ level, message, extra }),
    })

    await store.load()

    assert.equal(consoleCalls.length, 0)
    assert.equal(logCalls.length, 1)
    assert.equal(logCalls[0].level, "info")
    assert.match(logCalls[0].message, /cleaned 1 task/i)
    assert.equal(logCalls[0].extra.count, 1)
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    rmSync(dir, { recursive: true })
  }
})

test("structured logger records corrupted state without console output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  const consoleCalls = []
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = (...args) => consoleCalls.push(["log", ...args])
  console.warn = (...args) => consoleCalls.push(["warn", ...args])
  console.error = (...args) => consoleCalls.push(["error", ...args])
  try {
    writeFileSync(join(dir, "tasks.json"), "{not-json", "utf-8")
    const logCalls = []
    const store = new LoopStore({
      storageDir: dir,
      logger: async (level, message, extra) => logCalls.push({ level, message, extra }),
    })

    await store.load()

    assert.equal(consoleCalls.length, 0)
    assert.equal(logCalls.length, 1)
    assert.equal(logCalls[0].level, "warn")
    assert.match(logCalls[0].message, /corrupted/i)
    assert.match(logCalls[0].extra.backup, /\.corrupted\./)
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    rmSync(dir, { recursive: true })
  }
})

// --- ephemeral lifecycle (process identity) ---

test("ephemeral: same-process reload keeps tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const identity = { pid: 4242, startedAt: Date.now() - 10_000 }
    const s1 = new LoopStore({ storageDir: dir, processIdentity: identity })
    await s1.load()
    await s1.create({ prompt: "x", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "s1" })

    const s2 = new LoopStore({ storageDir: dir, processIdentity: identity })
    await s2.load()
    assert.equal(s2.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("ephemeral: tasks from a previous process are dropped on load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const s1 = new LoopStore({
      storageDir: dir,
      processIdentity: { pid: 1111, startedAt: Date.now() - 10_000 },
    })
    await s1.load()
    await s1.create({ prompt: "x", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "s1" })

    const logCalls = []
    const s2 = new LoopStore({
      storageDir: dir,
      processIdentity: { pid: 2222, startedAt: Date.now() },
      logger: async (level, message, extra) => logCalls.push({ level, message, extra }),
    })
    await s2.load()

    assert.equal(s2.list().length, 0)
    assert.equal(s2.state.pid, 2222, "new process identity adopted")
    assert.equal(logCalls.length, 1)
    assert.equal(logCalls[0].level, "info")
    assert.match(logCalls[0].message, /ephemeral cleanup: dropped 1 task/)
    assert.equal(logCalls[0].extra.previousPid, 1111)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("ephemeralTasks: false keeps tasks from a previous process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const s1 = new LoopStore({
      storageDir: dir,
      processIdentity: { pid: 1111, startedAt: Date.now() - 10_000 },
    })
    await s1.load()
    await s1.create({ prompt: "x", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "s1" })

    const s2 = new LoopStore({
      storageDir: dir,
      ephemeralTasks: false,
      processIdentity: { pid: 2222, startedAt: Date.now() },
    })
    await s2.load()
    assert.equal(s2.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("ephemeral: legacy state without pid is dropped; kept when ephemeralTasks is false", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const legacy = {
      version: 1,
      tasks: [
        {
          id: "legacy1",
          prompt: "from v0.2.11",
          mode: "fixed",
          intervalMs: 60_000,
          createdAt: Date.now(),
          lastFiredAt: 0,
          nextDueAt: Date.now() + 60_000,
          source: "user",
          directory: "/tmp",
          sessionID: "s1",
          paused: false,
        },
      ],
    }
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(legacy), "utf-8")
    const ephemeral = new LoopStore({ storageDir: dir })
    await ephemeral.load()
    assert.equal(ephemeral.list().length, 0, "legacy file cleaned under default ephemeral lifecycle")

    writeFileSync(join(dir, "tasks.json"), JSON.stringify(legacy), "utf-8")
    const durable = new LoopStore({ storageDir: dir, ephemeralTasks: false })
    await durable.load()
    assert.equal(durable.list().length, 1, "legacy file kept when ephemeralTasks is false")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("ephemeral: recycled pid with divergent startedAt is treated as a new process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const now = Date.now()
    const s1 = new LoopStore({
      storageDir: dir,
      processIdentity: { pid: 3333, startedAt: now - 120_000 },
    })
    await s1.load()
    await s1.create({ prompt: "x", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "s1" })

    // Same pid but boot time is 2 minutes off — the pid was recycled by the OS.
    const s2 = new LoopStore({
      storageDir: dir,
      processIdentity: { pid: 3333, startedAt: now },
    })
    await s2.load()
    assert.equal(s2.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("ephemeral: empty legacy state adopts identity without a cleanup log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    writeFileSync(join(dir, "tasks.json"), JSON.stringify({ version: 1, tasks: [] }), "utf-8")
    const logCalls = []
    const store = new LoopStore({
      storageDir: dir,
      logger: async (level, message, extra) => logCalls.push({ level, message, extra }),
    })
    await store.load()
    assert.equal(store.state.pid, process.pid)
    assert.equal(logCalls.length, 0, "nothing dropped, nothing logged")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- merge-write (B1: concurrent instances sharing one tasks.json) ---

test("merge-write: concurrent creates from two instances keep both tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const id = { pid: 1, startedAt: Date.now() }
    const s1 = new LoopStore({ storageDir: dir, processIdentity: id })
    const s2 = new LoopStore({ storageDir: dir, processIdentity: id })
    await s1.load()
    await s2.load()
    await s1.create({ prompt: "from s1", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    // s2 has stale in-memory state (does not know about s1's task)
    await s2.create({ prompt: "from s2", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sB" })

    const s3 = new LoopStore({ storageDir: dir, processIdentity: id })
    await s3.load()
    const prompts = s3.list().map((t) => t.prompt).sort()
    assert.deepEqual(prompts, ["from s1", "from s2"], "no task lost to last-writer-wins")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("merge-write: my cancel is not resurrected by a stale disk write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const id = { pid: 1, startedAt: Date.now() }
    const s1 = new LoopStore({ storageDir: dir, processIdentity: id })
    await s1.load()
    const t = await s1.create({ prompt: "doomed", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    await s1.cancel(t.id)

    // A stale peer rewrites the cancelled task back to disk.
    const disk = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"))
    disk.tasks.push(t)
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(disk), "utf-8")

    // s1's next write must keep the tombstone: the task stays gone.
    await s1.create({ prompt: "new", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    const s2 = new LoopStore({ storageDir: dir, processIdentity: id })
    await s2.load()
    assert.deepEqual(s2.list().map((x) => x.prompt), ["new"])
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("merge-write: tasks cancelled by another instance are accepted on next persist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const id = { pid: 1, startedAt: Date.now() }
    const s1 = new LoopStore({ storageDir: dir, processIdentity: id })
    const s2 = new LoopStore({ storageDir: dir, processIdentity: id })
    await s1.load()
    const t = await s1.create({ prompt: "shared", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    await s2.load()
    await s2.cancel(t.id)
    // s1 still holds the task in memory and touches an unrelated field via create.
    await s1.create({ prompt: "other", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    assert.deepEqual(s1.list().map((x) => x.prompt), ["other"], "peer deletion accepted after merge")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("cancelAll also tombstones ids only present on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const id = { pid: 1, startedAt: Date.now() }
    const s1 = new LoopStore({ storageDir: dir, processIdentity: id })
    const s2 = new LoopStore({ storageDir: dir, processIdentity: id })
    await s1.load()
    await s1.create({ prompt: "mine", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sA" })
    await s2.load()
    await s2.create({ prompt: "peer", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "sB" })
    // s1's memory only knows "mine"; stop-all must also kill s2's "peer".
    await s1.cancelAll()
    const s3 = new LoopStore({ storageDir: dir, processIdentity: id })
    await s3.load()
    assert.equal(s3.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- history.log append + rotation (B3) ---

test("logFire appends without rewriting and rotates at 1MB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const id = { pid: 1, startedAt: Date.now() }
    const store = new LoopStore({ storageDir: dir, processIdentity: id })
    await store.load()
    const task = await store.create({ prompt: "x", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "s1" })
    await store.logFire(task, true)
    await store.logFire(task, false)
    const lines = readFileSync(join(dir, "history.log"), "utf-8").trim().split("\n")
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).success, true)
    assert.equal(JSON.parse(lines[1]).success, false)

    // Force rotation: pre-fill beyond 1MB, then one more fire.
    writeFileSync(join(dir, "history.log"), "x".repeat(1_048_577), "utf-8")
    await store.logFire(task, true)
    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(join(dir, "history.1.log")), true, "rotated backup exists")
    const fresh = readFileSync(join(dir, "history.log"), "utf-8").trim().split("\n")
    assert.equal(fresh.length, 1, "fresh log starts over")
    assert.equal(JSON.parse(fresh[0]).success, true)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("TTL uses last activity: old-but-active tasks survive (B4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  try {
    const now = Date.now()
    const data = {
      version: 1,
      ...currentProcess(),
      tasks: [
        {
          id: "active-old",
          prompt: "created 8d ago, fired recently",
          mode: "fixed",
          intervalMs: 60_000,
          createdAt: now - 8 * 86_400_000,
          lastFiredAt: now - 60_000,
          nextDueAt: now + 60_000,
          source: "user",
          directory: "/tmp",
          sessionID: "s1",
          paused: false,
        },
        {
          id: "dead-old",
          prompt: "created 8d ago, never fired",
          mode: "fixed",
          intervalMs: 60_000,
          createdAt: now - 8 * 86_400_000,
          lastFiredAt: 0,
          nextDueAt: now + 60_000,
          source: "user",
          directory: "/tmp",
          sessionID: "s1",
          paused: false,
        },
      ],
    }
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(data), "utf-8")
    const store = new LoopStore({ storageDir: dir, taskTtlMs: 7 * 86_400_000 })
    await store.load()
    assert.deepEqual(store.list().map((t) => t.id), ["active-old"])
  } finally {
    rmSync(dir, { recursive: true })
  }
})
