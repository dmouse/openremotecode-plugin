import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { registerStatusChip } from "../../dist/opencode/status-chip.js"

async function isolated(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "status-chip-"))
  const previous = process.env.OPENCODE_REMOTE_DATA_DIR
  process.env.OPENCODE_REMOTE_DATA_DIR = directory
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENCODE_REMOTE_DATA_DIR
    else process.env.OPENCODE_REMOTE_DATA_DIR = previous
    await rm(directory, { recursive: true, force: true })
  })
}

const theme = { text: { base: "text", muted: "muted", feedback: { success: { base: "success" } } } }

test("the chip is claimed on both footer status slots, and cleanup releases both", async (t) => {
  await isolated(t)
  const claims = []
  let released = 0
  const stop = await registerStatusChip({ theme, ui: { slot: (claim) => { claims.push(claim); return () => { released++ } } } })
  // Home screen and session prompt, beside the prompt.
  assert.deepEqual(claims.map((claim) => claim.append).sort(), ["home.footer.status", "prompt.footer.status"])
  assert.ok(claims.every((claim) => typeof claim.render === "function"))
  stop()
  assert.equal(released, 2)
})

test("a host without slots or theme tokens gets no chip, and nothing throws", async (t) => {
  await isolated(t)
  const noSlot = await registerStatusChip({ theme, ui: {} })
  const noTheme = await registerStatusChip({ ui: { slot: () => { throw new Error("must not claim without a theme") } } })
  noSlot()
  noTheme()
})
