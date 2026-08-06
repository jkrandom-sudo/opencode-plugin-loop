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
  /** One-shot task: auto-cancelled after the first successful fire (fixed mode only). */
  once?: boolean
  /** Process that created (and fires) this task. Used to distinguish live
   *  foreign tasks from dead-process leftovers on load. */
  ownerPid?: number
  /** Owner process start time (epoch ms), guards against pid reuse. */
  ownerStartedAt?: number
  /** Maintenance tasks only: the loop.md file this task re-reads on every
   *  fire. When absent, the task fires its stored prompt snapshot. */
  loopFilePath?: string
  /** Hash of the loop.md content last injected — unchanged content fires a
   *  short cache-friendly reminder instead of the full text. */
  lastContentHash?: string
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
   * with the opencode process that created them. Each task records its owner
   * process; on load, tasks whose owner is confirmed dead are dropped, while
   * tasks owned by other LIVE processes are left untouched (each process fires
   * only its own tasks). Set to false to keep tasks across process restarts.
   */
  ephemeralTasks?: boolean
  /**
   * Instance coordination (default true): serializes plugin instances inside
   * one process (case-variant plugin paths, per-command `opencode run`
   * instances) so a task never fires twice; a lock held by a different
   * process does not block this process from firing its own tasks. Set to
   * false to disable coordination (not recommended).
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
  /** One-shot task (fixed mode only): auto-cancel after the first successful fire. */
  once?: boolean
  /** Maintenance tasks only: re-read this loop.md file on every fire. */
  loopFilePath?: string
  /** Hash of the loop.md content captured at creation. */
  lastContentHash?: string
}

export interface FireResult {
  message: string
  task: LoopTask
}
