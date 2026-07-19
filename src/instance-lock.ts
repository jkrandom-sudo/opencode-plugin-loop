/**
 * InstanceLock: single-leader election between plugin instances that share one
 * tasks.json. opencode can load the same plugin through two case-variant paths
 * (macOS case-insensitive FS), and every `opencode run --attach` spawns another
 * in-process instance — each with its own ticker. Without coordination every
 * instance fires the same due task (B1: duplicate fires + lost writes).
 *
 * Design:
 *  - The lock is a DIRECTORY ({storageDir}/loop.lock/) so acquisition is an
 *    atomic mkdirSync. Inside it, lock.json records the owner.
 *  - Same-process instances share a pid, so ownership is keyed by a random
 *    instanceId, not by pid.
 *  - The leader heartbeats by touching lock.json every heartbeatMs. A follower
 *    takes over only when the lock is stale (no heartbeat for staleMs) and it
 *    wins an atomic rename race.
 *  - Followers keep their ticker running but skip firing; commands and tool
 *    calls still work because every store write goes through merge-write.
 *
 * Implementation note: factory pattern (no `this` reliance) so opencode's
 * plugin loader can call us with or without `new`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { errorMessage, type LoopLogger } from "./runtime-feedback.js"

export interface InstanceLockOptions {
  storageDir: string
  /** Injectable for tests; defaults to a random UUID. */
  instanceId?: string
  /** Lock without a heartbeat for this long is considered abandoned (default 15_000). */
  staleMs?: number
  /** Heartbeat / takeover-probe interval (default 2_500). */
  heartbeatMs?: number
  logger?: LoopLogger
  /** Injectable clock for tests. */
  now?: () => number
}

export interface InstanceLockInstance {
  instanceId: string
  isLeader(): boolean
  /** Begin heartbeat / takeover probing. Safe to call once. */
  start(): void
  /** Stop probing; release the lock if leader. */
  stop(): void
}

interface LockFile {
  instanceId: string
  pid: number
  hostname: string
  startedAt: number
}

export function InstanceLock(this: unknown, options: InstanceLockOptions): InstanceLockInstance {
  void this
  const logger: LoopLogger = options.logger ?? (async () => {})
  const now = options.now ?? Date.now
  const instanceId = options.instanceId ?? randomUUID()
  const staleMs = options.staleMs ?? 15_000
  const heartbeatMs = options.heartbeatMs ?? 2_500
  const lockDir = join(options.storageDir, "loop.lock")
  const lockFile = join(lockDir, "lock.json")

  let leading = false
  let timer: ReturnType<typeof setInterval> | null = null

  const writeLockFile = () => {
    const body: LockFile = {
      instanceId,
      pid: process.pid,
      hostname: hostname(),
      startedAt: now(),
    }
    writeFileSync(lockFile, JSON.stringify(body, null, 2), "utf-8")
  }

  const readLockMtime = (): number | null => {
    try {
      return statSync(lockFile).mtimeMs
    } catch {
      return null
    }
  }

  const acquire = (): boolean => {
    try {
      mkdirSync(lockDir)
      writeLockFile()
      return true
    } catch {
      return false
    }
  }
  const tryTakeover = async (): Promise<boolean> => {
    if (acquire()) {
      await logger("info", "loop instance lock acquired", { instanceId })
      return true
    }
    // Lock held: am I the owner? (e.g. after a same-process reload)
    try {
      const owner = JSON.parse(readFileSync(lockFile, "utf-8")) as LockFile
      if (owner.instanceId === instanceId) return true
    } catch {
      // Unreadable lock file: fall through to staleness check
    }
    const mtime = readLockMtime()
    const stale = mtime === null || now() - mtime > staleMs
    if (!stale) return false
    // Abandoned lock: win an atomic rename race before deleting it, so two
    // followers cannot both take over.
    const graveyard = `${lockDir}.stale.${instanceId}`
    try {
      renameSync(lockDir, graveyard)
    } catch {
      return false
    }
    try {
      rmSync(graveyard, { recursive: true, force: true })
    } catch {
      // Non-fatal: a stale graveyard directory does not block acquisition.
    }
    const won = acquire()
    if (won) {
      await logger("info", "loop instance lock taken over from stale owner", { instanceId })
    }
    return won
  }

  const tick = async () => {
    try {
      if (leading) {
        // Still mine? A same-process follower may have taken over after
        // deciding our heartbeat stopped (e.g. event-loop stall).
        try {
          const owner = JSON.parse(readFileSync(lockFile, "utf-8")) as LockFile
          if (owner.instanceId !== instanceId) {
            leading = false
            await logger("warn", "loop instance lock lost", { instanceId })
            return
          }
        } catch {
          leading = false
          await logger("warn", "loop instance lock lost (unreadable)", { instanceId })
          return
        }
        try {
          const at = new Date(now())
          utimesSync(lockFile, at, at)
        } catch (err) {
          await logger("warn", "loop lock heartbeat failed", { error: errorMessage(err) })
        }
        return
      }
      leading = await tryTakeover()
    } catch (err) {
      await logger("warn", "loop instance lock tick failed", { error: errorMessage(err) })
    }
  }

  const inst: InstanceLockInstance = {
    instanceId,
    isLeader: () => leading,
    start: () => {
      if (timer) return
      void tick()
      timer = setInterval(() => void tick(), heartbeatMs)
      // Never keep the process alive just for the lock.
      if (typeof timer.unref === "function") timer.unref()
    },
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (leading) {
        try {
          const owner = JSON.parse(readFileSync(lockFile, "utf-8")) as LockFile
          if (owner.instanceId === instanceId) rmSync(lockDir, { recursive: true, force: true })
        } catch {
          // Lock already gone or unreadable — nothing to release.
        }
        leading = false
      }
    },
  }
  return inst
}
