/**
 * Jitter: deterministic random offset to prevent API spikes.
 *
 * Algorithm:
 *   - For intervals ≥ 1 hour: jitter up to ±30 minutes (Claude Code rule).
 *   - For intervals < 1 hour: jitter up to ±interval/2 (proportional).
 *   - No artificial 1-minute floor — short intervals get proportional jitter
 *     so a 30s task doesn't get pushed by ±60s.
 *
 * Deterministic per (taskId, time bucket) so the same task always gets
 * the same offset within a bucket.
 */

/** Simple deterministic hash → [0, 1) */
function hashToFloat(input: string): number {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000
}

const HOUR_MS = 3_600_000
const MAX_SLOW_JITTER_MS = 30 * 60 * 1000 // 30 minutes (for ≥1h tasks)
/** Bucket size for deterministic seeding. 1 second is fine for short intervals
 *  (faster re-roll → more variety across cycles) and harmless for long ones
 *  (the absolute jitter still dominates the bucket size). */
const BUCKET_MS = 1_000

export class Jitter {
  /**
   * @param _percent kept for backwards compat; ignored now (we follow Claude Code's rule)
   */
  constructor(_percent: number = 0.1) {
    // No-op: kept for API stability. The actual jitter is computed per-interval.
  }

  /**
   * Compute a deterministic offset for a task.
   * Returns a value in approximately (-maxMs, +maxMs):
   *   - maxMs = intervalMs / 2     if intervalMs < HOUR_MS
   *   - maxMs = MAX_SLOW_JITTER_MS if intervalMs >= HOUR_MS (capped at intervalMs / 2)
   *
   * Note: no artificial minimum — a 30s interval gets up to ±15s jitter,
   * not the old ±60s floor which broke short-interval tasks.
   */
  compute(taskId: string, intervalMs: number, atMs: number = Date.now()): number {
    const halfInterval = intervalMs / 2
    const maxMs = intervalMs < HOUR_MS ? halfInterval : Math.min(MAX_SLOW_JITTER_MS, halfInterval)

    // Time-bucket the seed for variety across cycles.
    const bucket = Math.floor(atMs / Math.max(BUCKET_MS, intervalMs))
    const seed = `${taskId}-${bucket}`
    const r = hashToFloat(seed) // [0, 1)
    const raw = (r * 2 - 1) * maxMs
    return Math.round(raw)
  }
}