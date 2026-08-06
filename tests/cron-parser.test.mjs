/**
 * Smoke test for CronParser
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { CronParser } from "../dist/cron-parser.js"

test("parse simple intervals", () => {
  const p = new CronParser()
  assert.equal(p.parse("5m")?.ms, 300_000)
  assert.equal(p.parse("2h")?.ms, 7_200_000)
  assert.equal(p.parse("30s")?.ms, 30_000)
  assert.equal(p.parse("1d")?.ms, 86_400_000)
  assert.equal(p.parse("90s")?.ms, 90_000)
  assert.equal(p.parse("120s")?.ms, 120_000)
})

test("reject invalid input", () => {
  const p = new CronParser()
  assert.equal(p.parse(""), null)
  assert.equal(p.parse("abc"), null)
  assert.equal(p.parse("5"), null)
  assert.equal(p.parse("5x"), null)
  assert.equal(p.parse("-5m"), null)
})

test("sub-minute intervals are honored exactly", () => {
  const p = new CronParser()
  // 30s is now exactly 30s, not rounded up
  assert.equal(p.parse("30s")?.ms, 30_000)
  assert.equal(p.parse("15s")?.ms, 15_000)
  assert.equal(p.parse("45s")?.ms, 45_000)
  // 1-second minimum
  assert.equal(p.parse("1s")?.ms, 1_000)
})

test("sub-second intervals rejected (below minimum)", () => {
  const p = new CronParser()
  // 0.5s would be 500ms — below 1000ms minimum, rejected
  assert.equal(p.parse("0.5s"), null)
})

test("extractInterval from command text", () => {
  const p = new CronParser()
  const r1 = p.extractInterval("5m check the deploy")
  assert.equal(r1.interval?.ms, 300_000)
  assert.equal(r1.rest, "check the deploy")
  const r2 = p.extractInterval("check the deploy")
  assert.equal(r2.interval, null)
  assert.equal(r2.rest, "check the deploy")
  const r3 = p.extractInterval("2h watch the tests")
  assert.equal(r3.interval?.ms, 7_200_000)
  assert.equal(r3.rest, "watch the tests")
  // sub-minute extraction
  const r4 = p.extractInterval("30s ping")
  assert.equal(r4.interval?.ms, 30_000)
  assert.equal(r4.rest, "ping")
})

test("format ms back to readable", () => {
  const p = new CronParser()
  assert.equal(p.format(1_000), "1s")
  assert.equal(p.format(30_000), "30s")
  assert.equal(p.format(60_000), "1m")
  assert.equal(p.format(300_000), "5m")
  assert.equal(p.format(3_600_000), "1h")
  assert.equal(p.format(7_200_000), "2h")
  assert.equal(p.format(86_400_000), "1d")
})
// --- trailing "every" clause extraction (Claude Code rule 2) ---

test("extractInterval: trailing every clause becomes a fixed interval", async () => {
  const cron = new CronParser()
  const cases = [
    ["check the deploy every 20m", 20 * 60_000, "check the deploy"],
    ["check the deploy every 30s", 30_000, "check the deploy"],
    ["check CI every 5 minutes", 5 * 60_000, "check CI"],
    ["look for failures every 2 hours", 2 * 3_600_000, "look for failures"],
    ["daily report every 1 day", 86_400_000, "daily report"],
    ["ping every 1.5h", 5_400_000, "ping"],
    ["CHECK EVERY 10M", 600_000, "CHECK"],
  ]
  for (const [input, ms, rest] of cases) {
    const r = cron.extractInterval(input)
    assert.ok(r.interval, `expected interval for: ${input}`)
    assert.equal(r.interval.ms, ms, input)
    assert.equal(r.rest, rest, input)
  }
})

test("extractInterval: trailing every without a time expression does not match", async () => {
  const cron = new CronParser()
  for (const input of ["check every PR", "review every merge request", "every 20m ago check"]) {
    const r = cron.extractInterval(input)
    assert.equal(r.interval, null, input)
  }
  // every in the middle is prompt text, not a schedule
  const mid = cron.extractInterval("check every 2m worth of logs")
  assert.equal(mid.interval, null)
  // empty prompt before the clause: interval extracted, rest empty
  const bare = cron.extractInterval("every 5m")
  assert.equal(bare.interval.ms, 300_000)
  assert.equal(bare.rest, "")
})

test("extractInterval: leading token wins over a trailing every clause", async () => {
  const cron = new CronParser()
  const r = cron.extractInterval("5m check the deploy every 2m")
  assert.equal(r.interval.ms, 300_000)
  assert.equal(r.rest, "check the deploy every 2m", "trailing clause stays in the prompt verbatim")
})
