/**
 * Parses interval strings like "5m", "2h", "30s", "1d" into milliseconds.
 *
 * Supports sub-minute intervals (e.g. "30s" → 30000ms) since opencode's
 * scheduler is a JavaScript setInterval, not a cron daemon.
 *
 * Minimum interval is 1 second (anything smaller is rejected as invalid).
 *
 * Implementation note: factory pattern (no `this` reliance) so opencode's
 * plugin loader can call us with or without `new`.
 */

export interface ParsedInterval {
  ms: number
  original: string
  /** Human-readable display */
  display: string
}

const UNIT_TO_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}
const MIN_INTERVAL_MS = 1_000

export interface CronParserInstance {
  parse(input: string): ParsedInterval | null
  extractInterval(text: string): { interval: ParsedInterval | null; rest: string }
  format(ms: number): string
  nextDueFrom(intervalMs: number, jitterMs?: number, fromMs?: number): number
}

export function CronParser(this: unknown): CronParserInstance {
  void this
  const inst: CronParserInstance = {
    /** Parse "5m" → 300_000, etc. Returns null if invalid. */
    parse(input: string) {
      const trimmed = input.trim().toLowerCase()
      if (!trimmed) return null

      const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(trimmed)
      if (!match) return null

      const num = parseFloat(match[1])
      const unit = match[2]
      const baseMs = UNIT_TO_MS[unit]
      if (!baseMs) return null

      let ms = num * baseMs

      // Minimum 1 second — opencode's setInterval can fire more often
      // than Claude Code's minute-granularity cron, so we honor the
      // user's exact request for sub-minute intervals.
      if (ms < MIN_INTERVAL_MS) return null

      return {
        ms,
        original: trimmed,
        display: inst.format(ms),
      }
    },

    /** Try to extract an interval from a user command like "5m check deploy" */
    extractInterval(text: string) {
      const tokens = text.trim().split(/\s+/)
      if (tokens.length === 0) return { interval: null, rest: text }

      const first = tokens[0]
      const parsed = inst.parse(first)
      if (parsed) {
        return {
          interval: parsed,
          rest: tokens.slice(1).join(" "),
        }
      }
      return { interval: null, rest: text }
    },

    /** "300000" → "5m" */
    format(ms: number) {
      if (ms < 60_000) return `${Math.round(ms / 1000)}s`
      if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
      if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
      return `${Math.round(ms / 86_400_000)}d`
    },

    /** Calculate next fire time, with optional jitter */
    nextDueFrom(intervalMs: number, jitterMs: number = 0, fromMs: number = Date.now()) {
      return fromMs + intervalMs + jitterMs
    },
  }
  return inst
}