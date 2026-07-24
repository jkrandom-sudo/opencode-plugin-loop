import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  LOOP_FEEDBACK_FILE,
  loopFeedbackPath,
  readLoopFeedback,
  writeLoopFeedback,
} from "../dist/feedback-channel.js"

test("writes and reads back a feedback payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-feedback-"))
  try {
    const storageDir = join(dir, "nested", "loop")
    const payload = { directory: "/repo", message: "📋 1 loop task(s):", ts: 123 }
    writeLoopFeedback(storageDir, payload)

    assert.equal(loopFeedbackPath(storageDir), join(storageDir, LOOP_FEEDBACK_FILE))
    assert.deepEqual(readLoopFeedback(loopFeedbackPath(storageDir)), payload)
    // Atomic write leaves no temp files behind.
    assert.deepEqual(
      readdirSync(storageDir).filter((name) => name.endsWith(".tmp")),
      [],
    )
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test("readLoopFeedback tolerates missing files and malformed payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-feedback-"))
  try {
    const path = loopFeedbackPath(dir)
    assert.equal(readLoopFeedback(path), undefined)

    writeFileSync(path, "not json", "utf8")
    assert.equal(readLoopFeedback(path), undefined)

    writeFileSync(path, JSON.stringify({ message: "x", ts: 1 }), "utf8")
    assert.equal(readLoopFeedback(path), undefined)

    writeFileSync(path, JSON.stringify({ directory: 1, message: "x", ts: 1 }), "utf8")
    assert.equal(readLoopFeedback(path), undefined)
  } finally {
    rmSync(dir, { recursive: true })
  }
})
