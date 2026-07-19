import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { InstanceLock } from "../dist/instance-lock.js"

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms))

function makeLock(dir, instanceId, extra = {}) {
  return new InstanceLock({
    storageDir: dir,
    instanceId,
    staleMs: 60,
    heartbeatMs: 20,
    ...extra,
  })
}

test("first instance becomes the only leader", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"))
  try {
    const a = makeLock(dir, "aaa")
    const b = makeLock(dir, "bbb")
    a.start()
    b.start()
    await tick(60)
    assert.equal(a.isLeader(), true)
    assert.equal(b.isLeader(), false)
    a.stop()
    b.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("follower takes over after the leader stops heartbeating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"))
  try {
    const a = makeLock(dir, "aaa")
    a.start()
    await tick(40)
    assert.equal(a.isLeader(), true)
    // Simulate a crashed leader: stop the heartbeat but leave the lock behind.
    a.stop()
    mkdirSync(join(dir, "loop.lock"), { recursive: true })
    writeFileSync(
      join(dir, "loop.lock", "lock.json"),
      JSON.stringify({ instanceId: "dead", pid: 1, hostname: "x", startedAt: Date.now() - 10_000 }),
      "utf-8"
    )
    // Backdate the heartbeat so the lock is stale.
    const past = new Date(Date.now() - 10_000)
    const { utimesSync } = await import("node:fs")
    utimesSync(join(dir, "loop.lock", "lock.json"), past, past)

    const b = makeLock(dir, "bbb")
    b.start()
    await tick(80)
    assert.equal(b.isLeader(), true)
    b.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("fresh lock is not taken over before the stale window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"))
  try {
    const a = makeLock(dir, "aaa")
    a.start()
    await tick(40)
    const b = makeLock(dir, "bbb")
    b.start()
    await tick(50)
    assert.equal(a.isLeader(), true, "leader keeps heartbeating")
    assert.equal(b.isLeader(), false)
    a.stop()
    b.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("concurrent takeover race: exactly one follower wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"))
  try {
    // Plant a stale lock from a dead owner.
    mkdirSync(join(dir, "loop.lock"), { recursive: true })
    writeFileSync(
      join(dir, "loop.lock", "lock.json"),
      JSON.stringify({ instanceId: "dead", pid: 1, hostname: "x", startedAt: Date.now() - 10_000 }),
      "utf-8"
    )
    const past = new Date(Date.now() - 10_000)
    const { utimesSync } = await import("node:fs")
    utimesSync(join(dir, "loop.lock", "lock.json"), past, past)

    const b = makeLock(dir, "bbb")
    const c = makeLock(dir, "ccc")
    b.start()
    c.start()
    await tick(120)
    const leaders = [b.isLeader(), c.isLeader()].filter(Boolean)
    assert.equal(leaders.length, 1, `exactly one leader, got ${leaders.length}`)
    b.stop()
    c.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("stop releases the lock so the next instance acquires immediately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"))
  try {
    const a = makeLock(dir, "aaa")
    a.start()
    await tick(40)
    assert.equal(a.isLeader(), true)
    a.stop()
    const b = makeLock(dir, "bbb")
    b.start()
    await tick(40)
    assert.equal(b.isLeader(), true)
    b.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("crashed leader (no stop) leaves a lock that is eventually taken over", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"))
  try {
    const a = makeLock(dir, "aaa")
    a.start()
    await tick(40)
    assert.equal(a.isLeader(), true)
    // Crash: do NOT call a.stop(). The lock file stays, heartbeats from a keep
    // it fresh though — so stop a's timer without releasing (real crash).
    a.stop()
    // Replant an abandoned lock older than staleMs.
    mkdirSync(join(dir, "loop.lock"), { recursive: true })
    writeFileSync(
      join(dir, "loop.lock", "lock.json"),
      JSON.stringify({ instanceId: "ghost", pid: 99999, hostname: "x", startedAt: Date.now() - 60_000 }),
      "utf-8"
    )
    const past = new Date(Date.now() - 60_000)
    const { utimesSync } = await import("node:fs")
    utimesSync(join(dir, "loop.lock", "lock.json"), past, past)

    const b = makeLock(dir, "bbb")
    b.start()
    await tick(100)
    assert.equal(b.isLeader(), true)
    b.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
