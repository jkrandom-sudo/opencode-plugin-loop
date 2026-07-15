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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import type { LoopTask, CreateTaskInput } from "./types.js"
import { errorMessage, type LoopLogger } from "./runtime-feedback.js"

export interface LoopStoreOptions {
  storageDir: string
  maxTasks?: number
  taskTtlMs?: number
  logger?: LoopLogger
}

interface PersistedState {
  version: 1
  tasks: LoopTask[]
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
        const cutoff = Date.now() - inst.taskTtlMs
        const filtered = parsed.tasks.filter((t) => t.createdAt > cutoff && !!t.sessionID)
        inst.state = { version: 1, tasks: filtered }
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
      const tmp = `${inst.filePath}.tmp`
      mkdirSync(dirname(tmp), { recursive: true })
      writeFileSync(tmp, JSON.stringify(inst.state, null, 2), "utf-8")
      renameSync(tmp, inst.filePath)
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
        adaptiveMinMs: input.adaptiveMinMs,
        adaptiveMaxMs: input.adaptiveMaxMs,
        createdAt: now,
        lastFiredAt: 0,
        nextDueAt: now + (input.intervalMs ?? input.adaptiveMaxMs ?? 60_000),
        source: input.source ?? "user",
        directory: input.directory,
        sessionID: input.sessionID,
        paused: false,
      }
      inst.state.tasks.push(task)
      await inst.persist()
      return task
    },
    cancel: async (id) => {
      const idx = inst.state.tasks.findIndex((t) => t.id === id)
      if (idx < 0) return null
      const [removed] = inst.state.tasks.splice(idx, 1)
      await inst.persist()
      return removed
    },
    cancelByPromptPrefix: async (prefix) => {
      const task = inst.state.tasks.find((t) => t.prompt.startsWith(prefix))
      if (!task) return null
      return inst.cancel(task.id)
    },
    cancelAll: async () => {
      const n = inst.state.tasks.length
      inst.state.tasks = []
      await inst.persist()
      return n
    },
    cancelBySession: async (sessionID) => {
      if (!sessionID) return 0
      const before = inst.state.tasks.length
      inst.state.tasks = inst.state.tasks.filter((t) => t.sessionID !== sessionID)
      const removed = before - inst.state.tasks.length
      if (removed > 0) await inst.persist()
      return removed
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
      await inst.persist()
      return task
    },
    reschedule: async (id, nextDueAt) => {
      const task = inst.get(id)
      if (!task) return null
      task.nextDueAt = nextDueAt
      await inst.persist()
      return task
    },
    setPaused: async (id, paused) => {
      const task = inst.get(id)
      if (!task) return null
      task.paused = paused
      await inst.persist()
      return task
    },
    logFire: async (task, success) => {
      const logFile = join(dirname(inst.filePath), "history.log")
      const line = JSON.stringify({
        ts: Date.now(),
        taskId: task.id,
        mode: task.mode,
        sessionID: task.sessionID,
        prompt: task.prompt.slice(0, 200),
        success,
      })
      try {
        mkdirSync(dirname(logFile), { recursive: true })
        const existing = existsSync(logFile) ? readFileSync(logFile, "utf-8") : ""
        writeFileSync(logFile, existing + line + "\n", "utf-8")
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
    inst.filePath = join(options.storageDir, "tasks.json")
    inst.maxTasks = options.maxTasks ?? 50
    inst.taskTtlMs = options.taskTtlMs ?? 7 * 24 * 60 * 60 * 1000
    if (!existsSync(options.storageDir)) {
      mkdirSync(options.storageDir, { recursive: true })
    }
  }

  return inst
}
