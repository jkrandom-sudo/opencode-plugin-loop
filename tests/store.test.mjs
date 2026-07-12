import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LoopStore } from "../dist/store.js"

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "loop-test-"))
  const store = new LoopStore({ storageDir: dir, maxTasks: 5, taskTtlMs: 60_000 })
  return { store, dir }
}

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