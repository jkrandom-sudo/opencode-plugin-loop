/**
 * LoopStore: persistent task store backed by JSON file.
 *
 * Layout: {storageDir}/tasks.json
 * - Atomic writes (write to .tmp, rename)
 * - Auto-expire tasks older than ttlMs
 * - Per-session isolation (each task is bound to its owning sessionID)
 * - On load, legacy tasks without sessionID are dropped
 *
 * Implementation note: opencode's plugin loader invokes `new X(...)` as `X(...)`
 * (without `new`) when loading npm-resolved plugins, which makes `this`
 * undefined inside function constructors. So we use a factory pattern that
 * does NOT depend on `this`: every method reads from a closed-over `inst`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import type { LoopTask, CreateTaskInput } from "./types.js"
import { errorMessage, type LoopLogger } from "./runtime-feedback.js"

export interface LoopStoreOptions {
  storageDir: string
  maxTasks?: number
  taskTtlMs?: number
  logger?: LoopLogger
  /**
   * Ephemeral lifecycle (default true): tasks written by a different process are
   * dropped on load. Process identity is tracked via pid + process start time so
   * same-process plugin reloads keep their tasks.
   */
  ephemeralTasks?: boolean
  /** Injectable process identity for tests; defaults to the current process. */
  processIdentity?: ProcessIdentity
}

export interface ProcessIdentity {
  pid: number
  startedAt: number
}

interface PersistedState {
  version: 1
  tasks: LoopTask[]
  pid?: number
  startedAt?: number
}

interface LoopStoreInstance {
  state: PersistedState
  filePath: string
  maxTasks: number
  taskTtlMs: number
  load(): Promise<void>
  persist(): Promise<void>
  generateId(): string
  create(input: CreateTaskInput): Promise<LoopTask>
  cancel(id: string): Promise<LoopTask | null>
  cancelByPromptPrefix(prefix: string): Promise<LoopTask | null>
  cancelAll(): Promise<number>
  cancelBySession(sessionID: string): Promise<number>
  list(): LoopTask[]
  listBySession(sessionID: string): LoopTask[]
  get(id: string): LoopTask | null
  getDueTasks(now?: number): Promise<LoopTask[]>
  getDueTasksForSession(sessionID: string, now?: number): Promise<LoopTask[]>
  getOrphanedTasks(): LoopTask[]
  markFired(id: string, nextDueAt?: number): Promise<LoopTask | null>
  reschedule(id: string, nextDueAt: number): Promise<LoopTask | null>
  setFixed(
    id: string,
    intervalMs: number,
    jitterEnabled: boolean,
    now?: number
  ): Promise<LoopTask | null>
  setPaused(id: string, paused: boolean): Promise<LoopTask | null>
  logFire(task: LoopTask, success: boolean): Promise<void>
}

export type { LoopStoreInstance }

// Factory function — does NOT depend on `this`. Returns a plain object that
// holds all state and methods. Callers can use it as `new LoopStore(opts)`
// (returns the object directly when called with `new`) or `LoopStore(opts)`
// (also returns the object directly).
export function LoopStore(this: unknown, options?: LoopStoreOptions): LoopStoreInstance {
  // IMPORTANT: do not access `this` here — opencode may call us without `new`,
  // in which case `this` is undefined in strict mode.
  void this
  let logger: LoopLogger = async () => {}
  let ephemeralTasks = true
  let identity: ProcessIdentity = {
    pid: process.pid,
    startedAt: Date.now() - process.uptime() * 1000,
  }
  /** Same-process reload keeps tasks; a different pid — or a recycled pid whose
   *  recorded start time diverges — means the writer was a previous process. */
  const PID_START_TOLERANCE_MS = 30_000
  const isSameProcess = (state: PersistedState): boolean =>
    state.pid === identity.pid &&
    state.startedAt !== undefined &&
    Math.abs(state.startedAt - identity.startedAt) <= PID_START_TOLERANCE_MS
  // Merge-write bookkeeping. Multiple plugin instances can share one
  // tasks.json (case-variant plugin paths, per-command `opencode run`
  // instances). `tombstones` are ids this instance cancelled — they must never
  // be resurrected from another instance's stale write. `dirtyIds` are ids
  // this instance touched — its version wins over the disk copy on merge.
  const tombstones = new Set<string>()
  const dirtyIds = new Set<string>()
  const readDisk = (): PersistedState | null => {
    try {
      if (!existsSync(inst.filePath)) return null
      const parsed = JSON.parse(readFileSync(inst.filePath, "utf-8")) as PersistedState
      if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) return null
      return parsed
    } catch {
      return null
    }
  }
  const HISTORY_MAX_BYTES = 1_048_576
  const inst: LoopStoreInstance = {
    state: { version: 1, tasks: [] },
    filePath: "",
    maxTasks: 50,
    taskTtlMs: 7 * 24 * 60 * 60 * 1000,
    load: async () => {
      if (!existsSync(inst.filePath)) {
        inst.state = { version: 1, tasks: [] }
        return
      }
      try {
        const raw = readFileSync(inst.filePath, "utf-8")
        const parsed = JSON.parse(raw) as PersistedState
        if (parsed.version !== 1) {
          throw new Error(`Unsupported state version: ${parsed.version}`)
        }
        if (ephemeralTasks && !isSameProcess(parsed)) {
          const dropped = parsed.tasks.length
          // Tombstone every id so merge-write cannot resurrect them.
          for (const t of parsed.tasks) tombstones.add(t.id)
          inst.state = { version: 1, tasks: [] }
          await inst.persist()
          if (dropped > 0) {
            await logger("info", `ephemeral cleanup: dropped ${dropped} task(s) from previous process`, {
              count: dropped,
              previousPid: parsed.pid,
            })
          }
          return
        }
        const cutoff = Date.now() - inst.taskTtlMs
        // B4: expire by last ACTIVITY, not creation — a task that keeps
        // firing must not be dropped just because it was created 7 days ago.
        const filtered = parsed.tasks.filter((t) => Math.max(t.createdAt, t.lastFiredAt ?? 0) > cutoff && !!t.sessionID && !tombstones.has(t.id))
        // Tombstone load-time deletions (expired/orphan) so merge-write
        // cannot resurrect them on the persist below.
        for (const t of parsed.tasks) {
          if (!filtered.includes(t)) tombstones.add(t.id)
        }
        inst.state = { version: 1, tasks: filtered }
        dirtyIds.clear()
        if (inst.state.tasks.length !== parsed.tasks.length) {
          await inst.persist()
          const dropped = parsed.tasks.length - inst.state.tasks.length
          await logger("info", `cleaned ${dropped} task(s) on load (orphan/expired)`, {
            count: dropped,
          })
        }
      } catch (err) {
        const backup = `${inst.filePath}.corrupted.${Date.now()}`
        try {
          renameSync(inst.filePath, backup)
        } catch {
          // ignore
        }
        inst.state = { version: 1, tasks: [] }
        await logger("warn", "tasks.json was corrupted and archived", {
          backup,
          error: errorMessage(err),
        })
      }
    },
    persist: async () => {
      // Merge with the on-disk state instead of blindly overwriting it, so
      // concurrent instances do not lose each other's tasks (B1).
      const disk = readDisk()
      if (disk) {
        const diskIds = new Set(disk.tasks.map((t) => t.id))
        const byId = new Map<string, LoopTask>()
        for (const dt of disk.tasks) {
          if (tombstones.has(dt.id)) continue
          byId.set(dt.id, dt)
        }
        for (const t of inst.state.tasks) {
          if (!dirtyIds.has(t.id) && !diskIds.has(t.id)) {
            // Vanished from disk and untouched by us: another instance
            // cancelled it — accept the deletion.
            continue
          }
          byId.set(t.id, t)
        }
        inst.state.tasks = Array.from(byId.values())
      }
      inst.state.pid = identity.pid
      inst.state.startedAt = identity.startedAt
      const tmp = `${inst.filePath}.tmp`
      mkdirSync(dirname(tmp), { recursive: true })
      writeFileSync(tmp, JSON.stringify(inst.state, null, 2), "utf-8")
      renameSync(tmp, inst.filePath)
      dirtyIds.clear()
    },
    generateId: () => {
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
      let id = ""
      for (let i = 0; i < 8; i++) {
        id += alphabet[Math.floor(Math.random() * alphabet.length)]
      }
      return id
    },
    create: async (input) => {
      if (inst.state.tasks.length >= inst.maxTasks) {
        throw new Error(`Max tasks (${inst.maxTasks}) reached. Cancel some before adding more.`)
      }
      if (!input.prompt?.trim()) {
        throw new Error("prompt must be non-empty")
      }
      if (!input.sessionID) {
        throw new Error("sessionID is required for loop tasks (per-session scoping)")
      }
      const now = Date.now()
      const task: LoopTask = {
        id: inst.generateId(),
        prompt: input.prompt,
        mode: input.mode,
        intervalMs: input.intervalMs,
        jitterEnabled: input.jitterEnabled,
        adaptiveMinMs: input.adaptiveMinMs,
        adaptiveMaxMs: input.adaptiveMaxMs,
        createdAt: now,
        lastFiredAt: 0,
        nextDueAt: now + (input.intervalMs ?? input.adaptiveMaxMs ?? 60_000),
        source: input.source ?? "user",
        directory: input.directory,
        sessionID: input.sessionID,
        paused: false,
        // Only present on one-shot tasks — keeps persisted JSON stable for
        // tasks that never use the field.
        ...(input.once ? { once: true as const } : {}),
      }
      inst.state.tasks.push(task)
      dirtyIds.add(task.id)
      await inst.persist()
      return task
    },
    cancel: async (id) => {
      const idx = inst.state.tasks.findIndex((t) => t.id === id)
      if (idx < 0) return null
      const [removed] = inst.state.tasks.splice(idx, 1)
      tombstones.add(id)
      dirtyIds.delete(id)
      await inst.persist()
      return removed
    },
    cancelByPromptPrefix: async (prefix) => {
      const task = inst.state.tasks.find((t) => t.prompt.startsWith(prefix))
      if (!task) return null
      return inst.cancel(task.id)
    },
    cancelAll: async () => {
      for (const t of inst.state.tasks) tombstones.add(t.id)
      // Also tombstone ids only known to the disk copy (created by other
      // instances) so stop-all --all really empties the shared file.
      const disk = readDisk()
      if (disk) for (const t of disk.tasks) tombstones.add(t.id)
      const n = inst.state.tasks.length
      inst.state.tasks = []
      dirtyIds.clear()
      await inst.persist()
      return n
    },
    cancelBySession: async (sessionID) => {
      if (!sessionID) return 0
      const removed = inst.state.tasks.filter((t) => t.sessionID === sessionID)
      if (removed.length === 0) return 0
      for (const t of removed) {
        tombstones.add(t.id)
        dirtyIds.delete(t.id)
      }
      inst.state.tasks = inst.state.tasks.filter((t) => t.sessionID !== sessionID)
      await inst.persist()
      return removed.length
    },
    list: () => [...inst.state.tasks],
    listBySession: (sessionID) => {
      if (!sessionID) return []
      return inst.state.tasks.filter((t) => t.sessionID === sessionID)
    },
    get: (id) => inst.state.tasks.find((t) => t.id === id) ?? null,
    getDueTasks: async (now: number = Date.now()) => {
      return inst.state.tasks.filter((t) => !t.paused && t.nextDueAt <= now)
    },
    getDueTasksForSession: async (sessionID: string, now: number = Date.now()) => {
      if (!sessionID) return []
      return inst.state.tasks.filter(
        (t) => !t.paused && t.sessionID === sessionID && t.nextDueAt <= now
      )
    },
    getOrphanedTasks: () => inst.state.tasks.filter((t) => !t.sessionID),
    markFired: async (id, nextDueAt) => {
      const task = inst.get(id)
      if (!task) return null
      task.lastFiredAt = Date.now()
      if (nextDueAt !== undefined) {
        task.nextDueAt = nextDueAt
      } else if (task.mode === "fixed" && task.intervalMs) {
        task.nextDueAt = task.lastFiredAt + task.intervalMs
      } else if (task.mode === "maintenance" && task.adaptiveMaxMs) {
        task.nextDueAt = task.lastFiredAt + task.adaptiveMaxMs
      }
      dirtyIds.add(id)
      await inst.persist()
      return task
    },
    reschedule: async (id, nextDueAt) => {
      const task = inst.get(id)
      if (!task) return null
      task.nextDueAt = nextDueAt
      dirtyIds.add(id)
      await inst.persist()
      return task
    },
    setFixed: async (id, intervalMs, jitterEnabled, now = Date.now()) => {
      const task = inst.get(id)
      if (!task) return null
      task.mode = "fixed"
      task.intervalMs = intervalMs
      task.jitterEnabled = jitterEnabled
      delete task.adaptiveMinMs
      delete task.adaptiveMaxMs
      task.lastFiredAt = now
      task.nextDueAt = now + intervalMs
      dirtyIds.add(id)
      await inst.persist()
      return task
    },
    setPaused: async (id, paused) => {
      const task = inst.get(id)
      if (!task) return null
      task.paused = paused
      dirtyIds.add(id)
      await inst.persist()
      return task
    },
    logFire: async (task, success) => {
      const logFile = join(dirname(inst.filePath), "history.log")
      const line =
        JSON.stringify({
          ts: Date.now(),
          taskId: task.id,
          mode: task.mode,
          sessionID: task.sessionID,
          prompt: task.prompt.slice(0, 200),
          success,
        }) + "\n"
      try {
        mkdirSync(dirname(logFile), { recursive: true })
        // O(1) append instead of read-rewrite (B3). Rotate BEFORE appending
        // when the log is oversize, keeping a single backup.
        if (existsSync(logFile) && statSync(logFile).size > HISTORY_MAX_BYTES) {
          renameSync(logFile, join(dirname(inst.filePath), "history.1.log"))
        }
        appendFileSync(logFile, line, "utf-8")
      } catch (err) {
        await logger("warn", "failed to write fire history", {
          error: errorMessage(err),
          taskId: task.id,
        })
      }
    },
  }

  if (options) {
    logger = options.logger ?? logger
    ephemeralTasks = options.ephemeralTasks ?? true
    identity = options.processIdentity ?? identity
    inst.filePath = join(options.storageDir, "tasks.json")
    inst.maxTasks = options.maxTasks ?? 50
    inst.taskTtlMs = options.taskTtlMs ?? 7 * 24 * 60 * 60 * 1000
    if (!existsSync(options.storageDir)) {
      mkdirSync(options.storageDir, { recursive: true })
    }
  }

  return inst
}
