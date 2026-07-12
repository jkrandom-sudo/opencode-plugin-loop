/**
 * Jitter: deterministic random offset to prevent API spikes.
 *
 * Three-tier algorithm — keeps the proportional effect Claude Code uses
 * for long intervals while preventing short/medium tasks from being
 * shifted by ~50% of their own period (which made a 10m task fire anywhere
 * in 5m..15m).
 *
 *   tier         |  interval range   |  max jitter     |  example
 *   -------------+-------------------+-----------------+------------------------
 *   short        |  < 5 minutes      |  ±15 seconds    |  30s task → 15..45s
 *   medium       |  5 min .. 1 hour  |  ±5%, capped    |  10m task → 9.5..10.5m
 *                |                   |  at ±1 minute   |
 *   long         |  ≥ 1 hour         |  ±30 minutes    |  6h task → 5.5..6.5h
 *
 * Deterministic per (taskId, time bucket) so the same task always gets
 * the same offset within a bucket.
 *
 * Implementation note: factory pattern (no `this` reliance) so opencode's
 * plugin loader can call us with or without `new`.
 */

/** FNV-1a 32-bit hash. Better mixing than the previous h*31+c additive
 *  hash, which left long numeric suffixes (the bucket id) almost
 *  indistinguishable — that caused every fire of a given task to land in
 *  a near-identical jitter slot, defeating the API-spike-prevention goal. */
function hashToFloat(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 1_000_000) / 1_000_000
}

const SECOND_MS = 1_000
const FIVE_MIN_MS = 5 * 60_000
const ONE_HOUR_MS = 60 * 60_000

/** Tier-1: short intervals (<5m). Fixed ±15s — proportional jitter on a 30s
 *  task would be ±15s anyway, but using a constant keeps 60s and 30s tasks
 *  distinct enough to spread API load. */
const MAX_SHORT_JITTER_MS = 15_000

/** Tier-2: medium intervals (5m..1h). ±5% of interval, capped at ±1 minute. */
const MEDIUM_JITTER_PCT = 0.05
const MAX_MEDIUM_JITTER_MS = 60_000

/** Tier-3: long intervals (≥1h). Fixed ±30 minutes — matches Claude Code. */
const MAX_LONG_JITTER_MS = 30 * 60_000

/** Bucket size for deterministic seeding. 1 second is fine for short intervals
 *  (faster re-roll → more variety across cycles) and harmless for long ones
 *  (the absolute jitter still dominates the bucket size). */
const BUCKET_MS = 1_000

export interface JitterInstance {
  compute(taskId: string, intervalMs: number, atMs?: number): number
}

export function Jitter(this: unknown, _percent: number = 0.1): JitterInstance {
  void this
  // No-op: kept for API stability. The actual jitter is computed per-interval.
  return {
    compute(taskId, intervalMs, atMs: number = Date.now()) {
      let maxMs: number
      if (intervalMs < FIVE_MIN_MS) {
        maxMs = MAX_SHORT_JITTER_MS
      } else if (intervalMs < ONE_HOUR_MS) {
        maxMs = Math.min(intervalMs * MEDIUM_JITTER_PCT, MAX_MEDIUM_JITTER_MS)
      } else {
        maxMs = MAX_LONG_JITTER_MS
      }
      const bucket = Math.floor(atMs / Math.max(BUCKET_MS, intervalMs))
      const seed = `${taskId}-${bucket}`
      const r = hashToFloat(seed)
      const raw = (r * 2 - 1) * maxMs
      return Math.round(raw)
    },
  }
}