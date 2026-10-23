import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { setupConnector } from "../../dist/opencode/setup.js"
import { FileFolderApprovalStore, resolveFolderApprovalsPath } from "../../dist/folder-approvals.js"

test("/remote approves the current location at invocation, not the launch directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "remote-setup-"))
  const launch = path.join(root, "launch"), current = path.join(root, "current")
  await Promise.all([mkdir(launch), mkdir(current)])
  const previous = process.env.OPENCODE_REMOTE_DATA_DIR
  process.env.OPENCODE_REMOTE_DATA_DIR = path.join(root, "private")
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENCODE_REMOTE_DATA_DIR
    else process.env.OPENCODE_REMOTE_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  let location = launch, commands
  const shown = [], answers = ["folder", true, "close"]
  const stop = await setupConnector({
    options: { apiUrl: "invalid" }, // No network or managed-service discovery.
    get location() { return { directory: location } },
    client: {}, data: { location: { default: () => ({ directory: launch }) } },
    keymap: { layer: (factory) => { commands = factory().commands } },
    ui: {
      toast: { show: () => {} },
      slot: (input) => { if (input.append === "app") input.render(); return () => {} },
      dialog: {
        select: async (input) => { shown.push(input); return answers.shift() },
        confirm: async (input) => { shown.push(input); return answers.shift() },
        alert: async (input) => { shown.push(input) },
      },
    },
  })
  try {
    location = current
    await commands.find((command) => command.slash?.name === "remote").run()
    const store = new FileFolderApprovalStore(resolveFolderApprovalsPath())
    assert.deepEqual((await store.list()).map((f) => f.path), [current])
    assert.equal((await store.inspect(launch)).enabled, false)
    assert.equal(shown[0].options[0].description, current)
  } finally { await stop() }
})
