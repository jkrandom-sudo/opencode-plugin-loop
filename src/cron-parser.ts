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

/** Word units accepted in trailing "every" clauses, mapped to s/m/h/d. */
const EVERY_UNIT: Record<string, string> = {
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s",
  m: "m", min: "m", mins: "m", minute: "m", minutes: "m",
  h: "h", hr: "h", hrs: "h", hour: "h", hours: "h",
  d: "d", day: "d", days: "d",
}

/**
 * Single validator shared by the slash parser, the LLM tool `create`, and
 * `set_fixed` — all entries must accept/reject the same fixed intervals.
 */
export function validateFixedInterval(
  ms: unknown
): { ok: true; ms: number } | { ok: false; error: string } {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return { ok: false, error: "intervalMs must be a finite number" }
  }
  if (ms < MIN_INTERVAL_MS) {
    return { ok: false, error: `intervalMs must be at least ${MIN_INTERVAL_MS}ms` }
  }
  return { ok: true, ms }
}

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

    /** Try to extract an interval from a user command like "5m check deploy".
     * `rest` is the ORIGINAL substring after the interval token (not a token
     * re-join), so prompt whitespace and newlines are preserved verbatim.
     * When the first token is not an interval, a trailing "every" clause is
     * extracted instead (Claude Code rule 2): "check deploy every 20m" →
     * fixed 20m + "check deploy". "check every PR" does not match. */
    extractInterval(text: string) {
      const trimmed = text.trim()
      if (!trimmed) return { interval: null, rest: text }
      const firstMatch = /^\S+/.exec(trimmed)
      const first = firstMatch?.[0] ?? ""
      const parsed = inst.parse(first)
      if (parsed) {
        return {
          interval: parsed,
          rest: trimmed.slice(first.length).replace(/^\s+/, ""),
        }
      }
      const every = /\bevery\s+(\d+(?:\.\d+)?)\s*([smhd]|seconds?|minutes?|hours?|days?)\s*$/i.exec(trimmed)
      if (every) {
        const unit = EVERY_UNIT[every[2].toLowerCase()]
        const parsedTail = unit ? inst.parse(`${every[1]}${unit}`) : null
        if (parsedTail) {
          return {
            interval: parsedTail,
            rest: trimmed.slice(0, every.index).trim(),
          }
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