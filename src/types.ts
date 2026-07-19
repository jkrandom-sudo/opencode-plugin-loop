/**
 * Shared types for the loop plugin
 */

export type TaskMode = "fixed" | "adaptive" | "maintenance"

export interface LoopTask {
  /** Unique 8-char ID */
  id: string
  /** User-provided prompt to re-inject each cycle */
  prompt: string
  /** Scheduling mode */
  mode: TaskMode
  /** Interval in milliseconds (fixed mode only) */
  intervalMs?: number
  /** Whether Fixed scheduling adds deterministic Jitter. Missing means enabled. */
  jitterEnabled?: boolean
  /** Adaptive bounds (adaptive mode only) */
  adaptiveMinMs?: number
  adaptiveMaxMs?: number
  /** When this task was first created (epoch ms) */
  createdAt: number
  /** When this task last fired (epoch ms, 0 if never) */
  lastFiredAt: number
  /** Next scheduled fire time (epoch ms) */
  nextDueAt: number
  /** Source of the loop: user command, default, etc. */
  source: "user" | "loop.md" | "default"
  /** Project directory (for scoping) */
  directory: string
  /** Session that owns this task. REQUIRED. Tasks without sessionID are dropped on load. */
  sessionID: string
  /** Disabled? */
  paused: boolean
}

export interface LoopConfig {
  /** Override default storage directory */
  storageDir?: string
  /** Max concurrent tasks (default 50) */
  maxTasks?: number
  /** Auto-expire tasks after N days (default 7) */
  taskTtlDays?: number
  /** @deprecated kept for backwards compat; jitter is now hardcoded to match Claude Code */
  jitterPercent?: number
  /** Adaptive minimum interval in ms (default 60_000) */
  defaultAdaptiveMinMs?: number
  /** Adaptive maximum interval in ms (default 3_600_000) */
  defaultAdaptiveMaxMs?: number
  /** Internal ticker interval in ms (default 5_000) */
  tickerIntervalMs?: number
  /** Default Jitter policy for newly created Fixed tasks (default true) */
  defaultJitterEnabled?: boolean
  /**
   * Ephemeral lifecycle (default true, matching Claude Code's /loop): tasks die
   * with the opencode process and are dropped on the next load. Set to false to
   * keep the legacy behavior of persisting tasks across process restarts.
   */
  ephemeralTasks?: boolean
  /**
   * Single-leader instance lock (default true): when several plugin instances
   * share one tasks.json (case-variant plugin paths, per-command `opencode
   * run` instances), only the leader's ticker fires tasks. Set to false to
   * disable coordination (not recommended).
   */
  instanceLock?: boolean
}

export interface CreateTaskInput {
  prompt: string
  mode: TaskMode
  intervalMs?: number
  jitterEnabled?: boolean
  adaptiveMinMs?: number
  adaptiveMaxMs?: number
  source?: LoopTask["source"]
  directory: string
  /** Required: the session this task is bound to */
  sessionID: string
}

export interface FireResult {
  message: string
  task: LoopTask
}
