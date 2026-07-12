/**
 * LoopStore: persistent task store backed by JSON file.
 *
 * Layout: {storageDir}/tasks.json
 * - Atomic writes (write to .tmp, rename)
 * - Auto-expire tasks older than ttlMs
 * - Per-session isolation (each task is bound to its owning sessionID)
 * - On load, legacy tasks without sessionID are dropped
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import type { LoopTask, CreateTaskInput } from "./types.js"

export interface LoopStoreOptions {
  storageDir: string
  maxTasks?: number
  taskTtlMs?: number
}

interface PersistedState {
  version: 1
  tasks: LoopTask[]
}

export class LoopStore {
  private state: PersistedState = { version: 1, tasks: [] }
  private readonly filePath: string
  private readonly maxTasks: number
  private readonly taskTtlMs: number

  constructor(options: LoopStoreOptions) {
    this.filePath = join(options.storageDir, "tasks.json")
    this.maxTasks = options.maxTasks ?? 50
    this.taskTtlMs = options.taskTtlMs ?? 7 * 24 * 60 * 60 * 1000
    if (!existsSync(options.storageDir)) {
      mkdirSync(options.storageDir, { recursive: true })
    }
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      this.state = { version: 1, tasks: [] }
      return
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8")
      const parsed = JSON.parse(raw) as PersistedState
      if (parsed.version !== 1) {
        throw new Error(`Unsupported state version: ${parsed.version}`)
      }
      // Auto-expire on load + drop orphan tasks (no sessionID)
      const cutoff = Date.now() - this.taskTtlMs
      const filtered = parsed.tasks.filter((t) => t.createdAt > cutoff && !!t.sessionID)
      this.state = {
        version: 1,
        tasks: filtered,
      }
      // Persist cleanup if anything was filtered
      if (this.state.tasks.length !== parsed.tasks.length) {
        await this.persist()
        const dropped = parsed.tasks.length - this.state.tasks.length
        console.log(`[opencode-plugin-loop] cleaned ${dropped} task(s) on load (orphan/expired)`)
      }
    } catch (err) {
      // Corrupted file: archive and start fresh
      const backup = `${this.filePath}.corrupted.${Date.now()}`
      try {
        renameSync(this.filePath, backup)
      } catch {
        // ignore
      }
      this.state = { version: 1, tasks: [] }
      console.warn(`[opencode-plugin-loop] tasks.json was corrupted; archived to ${backup}. Error: ${err}`)
    }
  }

  async persist(): Promise<void> {
    const tmp = `${this.filePath}.tmp`
    mkdirSync(dirname(tmp), { recursive: true })
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8")
    renameSync(tmp, this.filePath)
  }

  /** Generate 8-char ID like Claude Code */
  private generateId(): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    let id = ""
    for (let i = 0; i < 8; i++) {
      id += alphabet[Math.floor(Math.random() * alphabet.length)]
    }
    return id
  }

  async create(input: CreateTaskInput): Promise<LoopTask> {
    if (this.state.tasks.length >= this.maxTasks) {
      throw new Error(`Max tasks (${this.maxTasks}) reached. Cancel some before adding more.`)
    }
    if (!input.prompt?.trim()) {
      throw new Error("prompt must be non-empty")
    }
    if (!input.sessionID) {
      throw new Error("sessionID is required for loop tasks (per-session scoping)")
    }

    const now = Date.now()
    const task: LoopTask = {
      id: this.generateId(),
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

    this.state.tasks.push(task)
    await this.persist()
    return task
  }

  async cancel(id: string): Promise<LoopTask | null> {
    const idx = this.state.tasks.findIndex((t) => t.id === id)
    if (idx < 0) return null
    const [removed] = this.state.tasks.splice(idx, 1)
    await this.persist()
    return removed
  }

  async cancelByPromptPrefix(prefix: string): Promise<LoopTask | null> {
    const task = this.state.tasks.find((t) => t.prompt.startsWith(prefix))
    if (!task) return null
    return this.cancel(task.id)
  }

  async cancelAll(): Promise<number> {
    const n = this.state.tasks.length
    this.state.tasks = []
    await this.persist()
    return n
  }

  /** Cancel all tasks owned by a specific session. Returns count removed. */
  async cancelBySession(sessionID: string): Promise<number> {
    if (!sessionID) return 0
    const before = this.state.tasks.length
    this.state.tasks = this.state.tasks.filter((t) => t.sessionID !== sessionID)
    const removed = before - this.state.tasks.length
    if (removed > 0) await this.persist()
    return removed
  }

  list(): LoopTask[] {
    return [...this.state.tasks]
  }

  /** Return only tasks for the given session. */
  listBySession(sessionID: string): LoopTask[] {
    if (!sessionID) return []
    return this.state.tasks.filter((t) => t.sessionID === sessionID)
  }

  get(id: string): LoopTask | null {
    return this.state.tasks.find((t) => t.id === id) ?? null
  }

  /** Tasks whose nextDueAt has passed and aren't paused (all sessions) */
  async getDueTasks(now: number = Date.now()): Promise<LoopTask[]> {
    return this.state.tasks.filter((t) => !t.paused && t.nextDueAt <= now)
  }

  /** Due tasks limited to one session (per-session ticker) */
  async getDueTasksForSession(sessionID: string, now: number = Date.now()): Promise<LoopTask[]> {
    if (!sessionID) return []
    return this.state.tasks.filter(
      (t) => !t.paused && t.sessionID === sessionID && t.nextDueAt <= now
    )
  }

  /** Tasks missing sessionID (should be empty after load). For diagnostics. */
  getOrphanedTasks(): LoopTask[] {
    return this.state.tasks.filter((t) => !t.sessionID)
  }

  async markFired(id: string, nextDueAt?: number): Promise<LoopTask | null> {
    const task = this.get(id)
    if (!task) return null
    task.lastFiredAt = Date.now()
    if (nextDueAt !== undefined) {
      task.nextDueAt = nextDueAt
    } else if (task.mode === "fixed" && task.intervalMs) {
      task.nextDueAt = task.lastFiredAt + task.intervalMs
    } else if (task.mode === "maintenance" && task.adaptiveMaxMs) {
      task.nextDueAt = task.lastFiredAt + task.adaptiveMaxMs
    }
    // For adaptive: caller (LLM) must call reschedule
    await this.persist()
    return task
  }

  async reschedule(id: string, nextDueAt: number): Promise<LoopTask | null> {
    const task = this.get(id)
    if (!task) return null
    task.nextDueAt = nextDueAt
    await this.persist()
    return task
  }

  async setPaused(id: string, paused: boolean): Promise<LoopTask | null> {
    const task = this.get(id)
    if (!task) return null
    task.paused = paused
    await this.persist()
    return task
  }

  /** Record fire to history log */
  async logFire(task: LoopTask, success: boolean): Promise<void> {
    const logFile = join(dirname(this.filePath), "history.log")
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
      // Log failure is non-fatal
      console.warn(`[opencode-plugin-loop] failed to log fire: ${err}`)
    }
  }
}