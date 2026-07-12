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