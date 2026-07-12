import { test } from "node:test"
import assert from "node:assert/strict"
import { Jitter } from "../dist/jitter.js"

test("deterministic: same id+time → same offset", () => {
  const j = new Jitter()
  const o1 = j.compute("abc12345", 300_000, 1000000)
  const o2 = j.compute("abc12345", 300_000, 1000000)
  assert.equal(o1, o2)
})

test("fast tasks (interval < 1h): jitter ≤ interval/2", () => {
  const j = new Jitter()
  for (let i = 0; i < 50; i++) {
    const id = `task-${i}`
    const offset = j.compute(id, 300_000)
    assert.ok(Math.abs(offset) <= 150_000, `offset ${offset} exceeds interval/2`)
  }
})

test("slow tasks (interval ≥ 1h): jitter ≤ 30min AND interval/2", () => {
  const j = new Jitter()
  for (let i = 0; i < 50; i++) {
    const id = `task-${i}`
    const offset = j.compute(id, 3_600_000) // 1h interval
    assert.ok(Math.abs(offset) <= 1_800_000, `offset ${offset} exceeds 30min`)
    assert.ok(Math.abs(offset) <= 1_800_000, `offset ${offset} exceeds interval/2 (1h)`)
  }
})

test("very slow tasks (interval ≥ 1h): jitter ≤ 30min", () => {
  const j = new Jitter()
  for (let i = 0; i < 50; i++) {
    const id = `slow-${i}`
    const offset = j.compute(id, 86_400_000) // 1 day interval
    assert.ok(Math.abs(offset) <= 1_800_000, `offset ${offset} exceeds 30min`)
  }
})

test("short-interval tasks: jitter is proportional (no 60s floor)", () => {
  const j = new Jitter()
  // 30s interval → jitter ≤ 15s (was previously clamped to ±60s)
  for (let i = 0; i < 50; i++) {
    const offset = j.compute(`s-${i}`, 30_000)
    assert.ok(Math.abs(offset) <= 15_000, `offset ${offset} exceeds 15s for 30s interval`)
  }
  // 10s interval → jitter ≤ 5s
  for (let i = 0; i < 50; i++) {
    const offset = j.compute(`xs-${i}`, 10_000)
    assert.ok(Math.abs(offset) <= 5_000, `offset ${offset} exceeds 5s for 10s interval`)
  }
  // 5s interval → jitter ≤ 2.5s
  for (let i = 0; i < 50; i++) {
    const offset = j.compute(`xxs-${i}`, 5_000)
    assert.ok(Math.abs(offset) <= 2_500, `offset ${offset} exceeds 2.5s for 5s interval`)
  }
})

test("very-short tasks have non-zero jitter (still varied)", () => {
  const j = new Jitter()
  // For 5s interval, jitter should not be exactly 0
  const offsets = new Set()
  for (let i = 0; i < 30; i++) {
    offsets.add(j.compute(`var-${i}`, 5_000, 1000 + i * 100))
  }
  assert.ok(offsets.size > 1, `jitter should vary across tasks, got ${offsets.size} unique values`)
})