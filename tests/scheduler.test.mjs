import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LoopStore } from "../dist/store.js"
import { Scheduler } from "../dist/scheduler.js"
import { CronParser } from "../dist/cron-parser.js"
import { Jitter } from "../dist/jitter.js"

function makeScheduler(logger, random, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loop-sched-"))
  const store = new LoopStore({ storageDir: dir })
  const sched = new Scheduler({
    store,
    cron: new CronParser(),
    jitter: new Jitter(0.1),
    adaptiveMinMs: 60_000,
    adaptiveMaxMs: 3_600_000,
    logger,
    random,
    ...overrides,
  })
  return { sched, store, dir }
}

test("/loop 5m <prompt> → fixed mode", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("5m check deploy", "/tmp", "s1")
    assert.match(r.message, /Loop started/)
    assert.match(r.message, /5m/)
    assert.equal(r.task.mode, "fixed")
    assert.equal(r.task.intervalMs, 300_000)
    assert.equal(r.task.prompt, "check deploy")
    assert.equal(r.task.sessionID, "s1")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop <prompt> → adaptive mode", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("check the deploy", "/tmp", "s1")
    assert.match(r.message, /adaptive/)
    assert.equal(r.task.mode, "adaptive")
    assert.equal(r.task.intervalMs, undefined)
    assert.equal(r.task.adaptiveMinMs, 60_000)
    assert.equal(r.task.adaptiveMaxMs, 3_600_000)
    assert.equal(r.task.sessionID, "s1")
    assert.ok(r.task.lastFiredAt > 0, "initial model turn is recorded as the first execution")
    assert.match(r.modelPrompt, /check the deploy/)
    assert.match(r.modelPrompt, new RegExp(r.task.id))
    assert.match(r.modelPrompt, /set_fixed/)
    assert.match(r.modelPrompt, /delayMs/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop <prompt> persists a random adaptive fallback on creation", async () => {
  const { sched, store, dir } = makeScheduler(undefined, () => 0.5)
  try {
    const r = await sched.handleUserCommand("check the deploy", "/tmp", "s1")
    const delay = r.task.nextDueAt - r.task.createdAt
    assert.ok(delay >= 1_830_000 && delay < 1_830_100, `unexpected midpoint delay ${delay}`)
    const stored = store.get(r.task.id)
    assert.equal(stored.nextDueAt, r.task.nextDueAt, "initial execution preserves the fallback")
    assert.ok(stored.lastFiredAt > 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop (bare) → maintenance mode with adaptiveMaxMs set", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("", "/tmp", "s1")
    assert.match(r.message, /maintenance/)
    assert.equal(r.task.mode, "maintenance")
    assert.match(r.task.prompt, /Continue any unfinished work/)
    assert.equal(r.task.adaptiveMaxMs, 3_600_000, "maintenance has adaptiveMaxMs for re-arm")
    assert.equal(r.task.sessionID, "s1")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop without sessionID is rejected", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("5m test", "/tmp")
    assert.match(r.message, /active session/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("scheduler clamps adaptive ms within bounds", () => {
  const { sched } = makeScheduler()
  assert.equal(sched.clampAdaptive(10_000), 60_000)
  assert.equal(sched.clampAdaptive(10_000_000), 3_600_000)
  assert.equal(sched.clampAdaptive(180_000), 180_000)
})

test("scheduler rearmFixed sets next due based on interval + jitter", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("5m test", "/tmp", "s1")
    const task = r.task
    const before = Date.now()
    await sched.rearmFixed(task, before)
    // nextDueAt should be ≈ before + 5min (jitter ±interval/2)
    assert.ok(task.nextDueAt >= before + 300_000 - 150_000, `nextDueAt ${task.nextDueAt} too low`)
    assert.ok(task.nextDueAt <= before + 300_000 + 150_000, `nextDueAt ${task.nextDueAt} too high`)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("nextDueAt: fixed → interval + jitter", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const t = await store.create({ prompt: "f", mode: "fixed", intervalMs: 60_000, directory: "/tmp", sessionID: "s1" })
    for (let i = 0; i < 30; i++) {
      const now = Date.now()
      const nd = await sched.nextDueAt(t, now)
      const diff = nd - now
      // For 60s interval: jitter ∈ {-60000, +60000} → diff ∈ {0, 120000}
      assert.ok(diff >= 0 && diff <= 120_000, `diff ${diff} out of [0, 120000]`)
    }
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("fixed scheduling honors task-level jitterEnabled", async () => {
  const { sched, store, dir } = makeScheduler(undefined, undefined, {
    jitter: { compute: () => 1_234 },
  })
  try {
    const legacy = await store.create({
      prompt: "legacy",
      mode: "fixed",
      intervalMs: 60_000,
      directory: "/tmp",
      sessionID: "s1",
    })
    const exact = await store.create({
      prompt: "exact",
      mode: "fixed",
      intervalMs: 60_000,
      jitterEnabled: false,
      directory: "/tmp",
      sessionID: "s1",
    })
    const now = 10_000

    assert.equal(await sched.nextDueAt(legacy, now), 71_234)
    assert.equal(await sched.nextDueAt(exact, now), 70_000)

    await sched.rearmFixed(exact, now)
    assert.equal(store.get(exact.id).nextDueAt, 70_000)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("explicit fixed commands use the programmatic jitter default", async () => {
  const { sched, dir } = makeScheduler(undefined, undefined, {
    defaultJitterEnabled: false,
  })
  try {
    const result = await sched.handleUserCommand("2m check version", "/tmp", "s1")

    assert.equal(result.task.jitterEnabled, false)
    assert.equal(result.task.prompt, "check version")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("fixed command jitter flags override defaults only in the option prefix", async () => {
  const { sched, dir } = makeScheduler(undefined, undefined, {
    defaultJitterEnabled: false,
  })
  try {
    const enabled = await sched.handleUserCommand(
      "2m --jitter=true check version",
      "/tmp",
      "s1"
    )
    // A flag AFTER the prompt starts is prompt text, not an option (LOOP-001).
    const verbatim = await sched.handleUserCommand(
      "2m check deploy --jitter=false",
      "/tmp",
      "s1"
    )
    const invalid = await sched.handleUserCommand(
      "2m --jitter=maybe keep this text",
      "/tmp",
      "s1"
    )

    assert.equal(enabled.task.jitterEnabled, true)
    assert.equal(enabled.task.prompt, "check version")
    assert.equal(verbatim.task.jitterEnabled, false, "default applies; mid-prompt flag untouched")
    assert.equal(verbatim.task.prompt, "check deploy --jitter=false")
    assert.equal(invalid.task.jitterEnabled, false)
    assert.equal(invalid.task.prompt, "--jitter=maybe keep this text")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("nextDueAt: maintenance → adaptiveMaxMs", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const t = await store.create({ prompt: "m", mode: "maintenance", adaptiveMaxMs: 3_600_000, directory: "/tmp", sessionID: "s1" })
    const now = Date.now()
    const nd = await sched.nextDueAt(t, now)
    assert.equal(nd, now + 3_600_000)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("nextDueAt: adaptive → random task-specific fallback", async () => {
  const { sched, store, dir } = makeScheduler(undefined, () => 0.5)
  try {
    const t = await store.create({
      prompt: "a",
      mode: "adaptive",
      adaptiveMinMs: 1_000,
      adaptiveMaxMs: 3_000,
      directory: "/tmp",
      sessionID: "s1",
    })
    assert.equal(await sched.nextDueAt(t, 10_000), 12_000)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop list defaults to current session", async () => {
  const { sched, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand("list", "/tmp", "sA")
    assert.match(r.message, /1 loop task/, "A sees 1 task")
    assert.ok(!r.message.includes("in B"), "A does not see B's task")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop list --all is just list: --all is not a flag anymore", async () => {
  const { sched, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand("list --all", "/tmp", "sA")
    assert.match(r.message, /1 loop task/, "only the current session is listed")
    assert.ok(!r.message.includes("[s:"), "no session tags")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop cancel of another session's task is refused as not-in-session", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    const b = await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand(`cancel ${b.task.id}`, "/tmp", "sA")
    assert.match(r.message, /No task .+ in this session/)
    assert.ok(!r.message.includes("--all"), "no --all hint remains")
    assert.ok(store.get(b.task.id), "B task still exists")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop cancel <id> --all no longer overrides cross-session", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    const b = await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand(`cancel ${b.task.id} --all`, "/tmp", "sA")
    assert.match(r.message, /No task .+ in this session/)
    assert.ok(store.get(b.task.id), "B task untouched")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop stop-all cancels the current session only", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A1", "/tmp", "sA")
    await sched.handleUserCommand("5m in A2", "/tmp", "sA")
    await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand("stop-all", "/tmp", "sA")
    assert.match(r.message, /2 task/, "removes 2 from A")
    assert.equal(store.listBySession("sA").length, 0)
    assert.equal(store.listBySession("sB").length, 1, "B untouched")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop stop-all --all still only affects the current session", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("5m in A", "/tmp", "sA")
    await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand("stop-all --all", "/tmp", "sA")
    assert.match(r.message, /current session/)
    assert.equal(store.listBySession("sA").length, 0)
    assert.equal(store.listBySession("sB").length, 1, "B untouched")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop pause of another session's task is refused", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const b = await sched.handleUserCommand("5m in B", "/tmp", "sB")
    sched.currentSessionID = "sA"
    const r = await sched.handleUserCommand(`pause ${b.task.id}`, "/tmp", "sA")
    assert.match(r.message, /No task .+ in this session/)
    assert.equal(store.get(b.task.id).paused, false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop resume in the owning session rearms fixed", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const b = await sched.handleUserCommand("5m in B", "/tmp", "sB")
    await store.setPaused(b.task.id, true)
    const r = await sched.handleUserCommand(`resume ${b.task.id}`, "/tmp", "sB")
    assert.match(r.message, /Resumed/)
    assert.equal(store.get(b.task.id).paused, false)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("fireTask wraps fixed prompts with an explicit execution instruction", async () => {
  const { sched, dir } = makeScheduler(async () => {})
  try {
    const result = await sched.handleUserCommand("5m 输出当前系统时间", dir, "s1")
    const promptCalls = []
    const client = {
      session: {
        async prompt(args) {
          promptCalls.push(args)
          return true
        },
      },
    }

    await sched.fireTask(result.task, { client, directory: dir })

    assert.equal(promptCalls.length, 1)
    const text = promptCalls[0].body.parts[0].text
    assert.match(text, /scheduled execution of \/loop task/)
    assert.match(text, new RegExp(result.task.id))
    assert.match(text, /输出当前系统时间/)
    assert.match(text, /Perform the task/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("fireTask failure uses structured logger without console output", async () => {
  const logCalls = []
  const consoleCalls = []
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = (...args) => consoleCalls.push(["log", ...args])
  console.warn = (...args) => consoleCalls.push(["warn", ...args])
  console.error = (...args) => consoleCalls.push(["error", ...args])
  const { sched, dir } = makeScheduler(async (level, message, extra) => {
    logCalls.push({ level, message, extra })
  })
  try {
    const result = await sched.handleUserCommand("5m fail", dir, "s1")
    const client = {
      session: {
        async prompt() {
          throw new Error("prompt failed")
        },
      },
    }

    await sched.fireTask(result.task, { client, directory: dir })

    assert.equal(consoleCalls.length, 0)
    assert.equal(logCalls.length, 1)
    assert.equal(logCalls[0].level, "error")
    assert.match(logCalls[0].message, /failed to fire task/i)
    assert.equal(logCalls[0].extra.taskId, result.task.id)
    assert.equal(logCalls[0].extra.error, "prompt failed")
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    rmSync(dir, { recursive: true })
  }
})

// --- c2: parsing hygiene + help ---

test("/loop help shows usage with all flags", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("help", "/tmp", "s1")
    assert.equal(r.task, undefined)
    assert.ok(!r.message.includes("--all"), "--all is gone from help")
    assert.match(r.message, /--jitter=true\|false/)
    assert.match(r.message, /--once/)
    assert.match(r.message, /--cancel, --list/)
    assert.match(r.message, /cancel <id>/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop 5m (interval, no prompt) errors instead of creating a task", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("5m", "/tmp", "s1")
    assert.equal(r.task, undefined)
    assert.match(r.message, /Missing prompt/)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop 0s x and /loop 999x x are rejected as invalid intervals", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    for (const args of ["0s test", "999x test", "5 test"]) {
      const r = await sched.handleUserCommand(args, "/tmp", "s1")
      assert.equal(r.task, undefined, args)
      assert.match(r.message, /Invalid interval/, args)
    }
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("cron-shaped input is rejected with guidance", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("*/5 * * * * check build", "/tmp", "s1")
    assert.equal(r.task, undefined)
    assert.match(r.message, /Cron expressions are not supported/)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("--all is no longer a flag: kept as prompt text / rejected in command position", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r1 = await sched.handleUserCommand("5m --all check deploy", "/tmp", "s1")
    assert.equal(r1.task.prompt, "--all check deploy", "not a known flag → treated as prompt text")
    const r2 = await sched.handleUserCommand("--all check the weather", "/tmp", "s1")
    assert.equal(r2.task, undefined)
    assert.match(r2.message, /Unknown flag "--all"/)
    assert.equal(store.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("surrounding quotes are stripped before parsing (B10)", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand('"5m check deploy"', "/tmp", "s1")
    assert.equal(r.task.mode, "fixed")
    assert.equal(r.task.prompt, "check deploy")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("Claude Code-style flags map to subcommands (P-1)", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const created = await sched.handleUserCommand("5m check deploy", "/tmp", "s1")
    const id = created.task.id

    const listed = await sched.handleUserCommand("--list", "/tmp", "s1")
    assert.match(listed.message, /loop task/)

    const cancelled = await sched.handleUserCommand(`--cancel ${id}`, "/tmp", "s1")
    assert.match(cancelled.message, /Cancelled/)
    assert.equal(store.get(id), null)

    const bad = await sched.handleUserCommand("--bogus do something", "/tmp", "s1")
    assert.equal(bad.task, undefined)
    assert.match(bad.message, /Unknown flag/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("usage errors are in English", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("cancel", "/tmp", "s1")
    assert.match(r.message, /Usage: \/loop cancel <taskId>/)
    assert.doesNotMatch(r.message, /用法/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- c3: scheduling semantics ---

test("bare /loop maintenance runs immediately and re-arms on the slow cycle", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const before = Date.now()
    const r = await sched.handleUserCommand("", "/tmp", "s1")
    assert.equal(r.task.mode, "maintenance")
    assert.ok(r.modelPrompt, "maintenance prompt runs in the current turn")
    assert.match(r.message, /Running now/)
    const t = store.get(r.task.id)
    assert.ok(t.lastFiredAt >= before, "marked as fired")
    assert.ok(t.nextDueAt >= before + 3_500_000, "next run ~1h out")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("resume re-arms adaptive and maintenance tasks instead of catch-up firing (B6)", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const a = await sched.handleUserCommand("check things", "/tmp", "s1")
    await store.reschedule(a.task.id, Date.now() - 60_000)
    await sched.handleUserCommand(`pause ${a.task.id}`, "/tmp", "s1")
    const rr = await sched.handleUserCommand(`resume ${a.task.id}`, "/tmp", "s1")
    assert.match(rr.message, /Resumed/)
    const after = store.get(a.task.id)
    assert.ok(after.nextDueAt > Date.now(), "adaptive re-armed into the future")

    const m = await sched.handleUserCommand("", "/tmp", "s1")
    await store.reschedule(m.task.id, Date.now() - 60_000)
    await sched.handleUserCommand(`pause ${m.task.id}`, "/tmp", "s1")
    await sched.handleUserCommand(`resume ${m.task.id}`, "/tmp", "s1")
    const mAfter = store.get(m.task.id)
    assert.ok(mAfter.nextDueAt > Date.now() + 3_500_000, "maintenance re-armed ~1h out")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("fixed tasks re-arm from fire start, not fire completion (no drift)", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("60s --jitter=false say hi", "/tmp", "s1")
    const t0 = 1_800_000_000_000
    const mockCtx = { client: { session: { async prompt() { return { info: {}, parts: [] } } } } }
    await sched.executeTask(store.get(r.task.id), mockCtx, t0)
    const after = store.get(r.task.id)
    assert.equal(after.nextDueAt, t0 + 60_000, "next fire anchored to fire start")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- c4: --once one-shot tasks ---

test("/loop 30s --once fires exactly once then auto-cancels", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("30s --once say hi", "/tmp", "s1")
    assert.equal(r.task.mode, "fixed")
    assert.equal(r.task.once, true)
    assert.equal(r.task.prompt, "say hi")
    assert.match(r.message, /runs once/)

    const t0 = 1_800_000_000_000
    const mockCtx = { client: { session: { async prompt() { return { info: {}, parts: [] } } } } }
    await sched.executeTask(store.get(r.task.id), mockCtx, t0)
    assert.equal(store.get(r.task.id), null, "task auto-cancelled after first fire")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("--once task survives a failed fire (retry next cycle)", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("30s --once say hi", "/tmp", "s1")
    const failingCtx = { client: { session: { async prompt() { throw new Error("boom") } } } }
    await sched.executeTask(store.get(r.task.id), failingCtx, 1_800_000_000_000)
    assert.ok(store.get(r.task.id), "task kept for retry")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("--once without an interval is rejected", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("--once check things", "/tmp", "s1")
    assert.equal(r.task, undefined)
    assert.match(r.message, /--once is only supported for fixed/)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("list marks one-shot tasks", async () => {
  const { sched, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("30s --once say hi", "/tmp", "s1")
    const r = await sched.handleUserCommand("list", "/tmp", "s1")
    assert.match(r.message, /once/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- LOOP-001: prompt fidelity (flags only parsed in the option prefix) ---

test("LOOP-001: flag-like text inside the prompt is preserved verbatim", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const marker = '中文 空格 "双引号" \'单引号\' `反引号` --once --all $HOME'
    const r = await sched.handleUserCommand(`1m --jitter=false 把 marker 原样写入：${marker}`, "/tmp", "s1")
    assert.equal(r.task.prompt, `把 marker 原样写入：${marker}`)
    assert.equal(store.get(r.task.id).prompt, `把 marker 原样写入：${marker}`, "persisted verbatim")
    assert.equal(r.task.jitterEnabled, false, "prefix flag still parsed")
    assert.equal(r.task.once, undefined, "--once in the body does not make the task one-shot")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("LOOP-001: prefix --once applies; body --once does not", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const oneShot = await sched.handleUserCommand("30s --once remind --once me", "/tmp", "s1")
    assert.equal(oneShot.task.once, true)
    assert.equal(oneShot.task.prompt, "remind --once me")
    const recurring = await sched.handleUserCommand("30s remind --once me", "/tmp", "s1")
    assert.equal(recurring.task.once, undefined)
    assert.equal(recurring.task.prompt, "remind --once me")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("LOOP-001: -- terminator forces the rest to be prompt text", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const fixed = await sched.handleUserCommand("1m --once -- run tests --jitter=true --all", "/tmp", "s1")
    assert.equal(fixed.task.once, true)
    assert.equal(fixed.task.prompt, "run tests --jitter=true --all")
    assert.equal(fixed.task.jitterEnabled, true, "default jitter; body flag not parsed")
    const adaptive = await sched.handleUserCommand("-- check --once things", "/tmp", "s1")
    assert.equal(adaptive.task.mode, "adaptive")
    assert.equal(adaptive.task.prompt, "check --once things")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("LOOP-001: prompt whitespace and newlines are preserved", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const body = "line one\nline  two   spaced"
    const r = await sched.handleUserCommand(`1m ${body}`, "/tmp", "s1")
    assert.equal(r.task.prompt, body)
    const a = await sched.handleUserCommand(`keep  double   spaces\nand newline`, "/tmp", "s1")
    assert.equal(a.task.prompt, "keep  double   spaces\nand newline")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("LOOP-001: duplicate prefix flags are idempotent; last jitter wins", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("1m --once --once --jitter=true --jitter=false go", "/tmp", "s1")
    assert.equal(r.task.once, true)
    assert.equal(r.task.jitterEnabled, false)
    assert.equal(r.task.prompt, "go")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- /loop stop without an id cancels every task in scope ---

test("/loop stop without an id cancels all tasks in the current session", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("1m task A1", "/tmp", "sA")
    await sched.handleUserCommand("1m task A2", "/tmp", "sA")
    await sched.handleUserCommand("1m task B1", "/tmp", "sB")
    const r = await sched.handleUserCommand("stop", "/tmp", "sA")
    assert.match(r.message, /Cancelled 2 task\(s\) in current session/)
    assert.equal(store.list().length, 1, "session B untouched")
    assert.equal(store.list()[0].prompt, "task B1")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop stop <id> still cancels a single task", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const a = await sched.handleUserCommand("1m task A1", "/tmp", "sA")
    await sched.handleUserCommand("1m task A2", "/tmp", "sA")
    const r = await sched.handleUserCommand(`stop ${a.task.id}`, "/tmp", "sA")
    assert.match(r.message, new RegExp(`Cancelled ${a.task.id}`))
    assert.equal(store.list().length, 1)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop stop --all: the extra token is treated as an id and not found", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    await sched.handleUserCommand("1m task A1", "/tmp", "sA")
    await sched.handleUserCommand("1m task B1", "/tmp", "sB")
    const r = await sched.handleUserCommand("stop --all", "/tmp", "sA")
    assert.match(r.message, /No task --all in this session/)
    assert.equal(store.list().length, 2, "nothing cancelled")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- 0.8.0: fixed tasks run immediately on creation (Claude Code parity) ---

test("recurring fixed task executes in the creation turn and is re-armed from now", async () => {
  const { sched, store, dir } = makeScheduler(undefined, () => 0.5)
  try {
    const before = Date.now()
    const r = await sched.handleUserCommand("5m check the build", "/tmp", "s1")
    const after = Date.now()
    assert.match(r.modelPrompt, /first execution/, "creation turn IS the first execution")
    assert.match(r.modelPrompt, /check the build/)
    assert.match(r.modelPrompt, /every 5m/)
    const t = store.get(r.task.id)
    assert.ok(t.lastFiredAt >= before && t.lastFiredAt <= after, "first run recorded")
    // 5m is the medium jitter tier (±5%) — next fire is anchored to creation
    // time within the jitter window.
    assert.ok(t.nextDueAt >= before + 285_000, "next fire anchored to creation time")
    assert.ok(t.nextDueAt <= after + 315_000, "within the jitter window")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("one-shot fixed task is due immediately instead of running in the creation turn", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("30s --once remind me", "/tmp", "s1")
    assert.equal(r.task.once, true)
    assert.ok(r.task.nextDueAt <= Date.now(), "due now — ticker fires it within one tick")
    assert.match(r.modelPrompt, /successfully created/, "creation confirmation, not execution")
    assert.equal(store.get(r.task.id).lastFiredAt, 0, "no execution recorded yet")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- 0.8.0: user-level ~/.opencode/loop.md ---

test("bare /loop falls back to the user-level loop.md, project file wins", async () => {
  const { sched, dir } = makeScheduler()
  const fakeHome = mkdtempSync(join(tmpdir(), "loop-home-"))
  const project = mkdtempSync(join(tmpdir(), "loop-proj-"))
  const realHome = process.env.HOME
  try {
    mkdirSync(join(fakeHome, ".opencode"), { recursive: true })
    writeFileSync(join(fakeHome, ".opencode", "loop.md"), "user-level maintenance")
    process.env.HOME = fakeHome

    assert.equal(sched.loadDefaultPrompt(project), "user-level maintenance")

    mkdirSync(join(project, ".opencode"), { recursive: true })
    writeFileSync(join(project, ".opencode", "loop.md"), "project-level maintenance")
    assert.equal(sched.loadDefaultPrompt(project), "project-level maintenance")
  } finally {
    process.env.HOME = realHome
    rmSync(dir, { recursive: true })
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

// --- 0.8.1: trailing "every" clause creates a fixed task ---

test("/loop check deploy every 2m → fixed, runs now (first-run prompt)", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("check deploy every 2m", "/tmp", "s1")
    assert.equal(r.task.mode, "fixed")
    assert.equal(r.task.intervalMs, 120_000)
    assert.equal(r.task.prompt, "check deploy")
    assert.match(r.modelPrompt, /first execution/)
    assert.ok(store.get(r.task.id).lastFiredAt > 0)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop --once check every 30s → one-shot fixed due immediately", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("--once check every 30s", "/tmp", "s1")
    assert.equal(r.task.mode, "fixed")
    assert.equal(r.task.once, true)
    assert.equal(r.task.intervalMs, 30_000)
    assert.equal(r.task.prompt, "check")
    assert.ok(r.task.nextDueAt <= Date.now())
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("/loop check every PR stays adaptive (no time expression)", async () => {
  const { sched, dir } = makeScheduler()
  try {
    const r = await sched.handleUserCommand("check every PR", "/tmp", "s1")
    assert.equal(r.task.mode, "adaptive")
    assert.equal(r.task.prompt, "check every PR")
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// --- 0.8.1: file-backed maintenance re-reads loop.md on every fire ---

test("maintenance fire re-reads loop.md: unchanged → reminder, edited → full text, deleted → no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-sched-"))
  const project = mkdtempSync(join(tmpdir(), "loop-proj-"))
  try {
    const store = new LoopStore({ storageDir: dir })
    const sched = new Scheduler({
      store,
      cron: new CronParser(),
      jitter: new Jitter(0.1),
      adaptiveMinMs: 60_000,
      adaptiveMaxMs: 3_600_000,
    })
    const loopFile = join(project, ".opencode", "loop.md")
    mkdirSync(join(project, ".opencode"), { recursive: true })
    writeFileSync(loopFile, "maintenance v1")

    const r = await sched.handleUserCommand("", project, "s1")
    assert.equal(r.task.mode, "maintenance")
    assert.equal(r.task.loopFilePath, loopFile)
    assert.ok(r.task.lastContentHash, "content hash recorded at creation")

    const promptCalls = []
    const ctx = { client: { session: { async prompt(a) { promptCalls.push(a); return true } } }, directory: project }

    // Unchanged content → short reminder, no full text
    await sched.fireTask(store.get(r.task.id), ctx)
    assert.match(promptCalls[0].body.parts[0].text, /unchanged/)
    assert.ok(!promptCalls[0].body.parts[0].text.includes("maintenance v1"))

    // Edited content → full text injected, hash updated and persisted
    writeFileSync(loopFile, "maintenance v2 changed")
    await sched.fireTask(store.get(r.task.id), ctx)
    assert.match(promptCalls[1].body.parts[0].text, /maintenance v2 changed/)
    const persisted = store.get(r.task.id)
    assert.equal(persisted.prompt, "maintenance v2 changed")
    const disk = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"))
    assert.equal(disk.tasks[0].prompt, "maintenance v2 changed", "hash/content persisted")

    // Deleted file → no-op tick (no injection)
    rmSync(loopFile)
    const fired = await sched.fireTask(store.get(r.task.id), ctx)
    assert.equal(fired, false)
    assert.equal(promptCalls.length, 2, "no new injection after file deletion")
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
})

test("snapshot maintenance tasks (no loopFilePath) keep firing the stored prompt", async () => {
  const { sched, store, dir } = makeScheduler()
  try {
    const t = await store.create({
      prompt: "legacy snapshot",
      mode: "maintenance",
      adaptiveMaxMs: 3_600_000,
      directory: "/tmp",
      sessionID: "s1",
    })
    const promptCalls = []
    const ctx = { client: { session: { async prompt(a) { promptCalls.push(a); return true } } }, directory: "/tmp" }
    await sched.fireTask(store.get(t.id), ctx)
    assert.match(promptCalls[0].body.parts[0].text, /legacy snapshot/)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
