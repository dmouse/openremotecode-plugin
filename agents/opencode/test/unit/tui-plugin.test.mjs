import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { FileConnectorPairingStore } from "../../dist/auth/pairing-store.js"
import plugin from "../../dist/tui.js"

test("native remote command displays the pending code without submitting a prompt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-tui-"))
  const previousDataDirectory = process.env.OPENCODE_REMOTE_DATA_DIR
  process.env.OPENCODE_REMOTE_DATA_DIR = directory
  try {
    await new FileConnectorPairingStore(path.join(directory, "connector-pairing.json")).replace({
      version: 1,
      serviceOrigin: "https://remote.example.test",
      connectorKeyId: "c".repeat(43),
      pairingId: "par_0123456789abcdefghijklmn",
      pairingSecret: `orp_${"A".repeat(43)}`,
      userCode: "ABCD-EFGH",
      serviceId: "test-service",
      verificationUri: "https://remote.example.test/pair",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      pollIntervalSeconds: 2,
    })

    let layer
    let dialog
    let unregisterCalled = false
    const disposers = []
    const controller = new AbortController()
    const api = {
      theme: { current: { success: "#a3d977", textMuted: "#888888", text: "#ffffff" } },
      slots: { register() { return "status-chip" } },
      keymap: {
        registerLayer(value) {
          layer = value
          return () => { unregisterCalled = true }
        },
      },
      lifecycle: {
        signal: controller.signal,
        onDispose(callback) { disposers.push(callback) },
      },
      ui: {
        DialogSelect: (props) => props,
        DialogConfirm: (props) => props,
        dialog: {
          setSize() {},
          replace(render) { dialog = render() },
          clear() {},
        },
      },
    }

    await plugin.tui(api)
    const command = layer.commands.find((candidate) => candidate.slashName === "remote")
    assert.ok(command)
    await command.run()
    assert.equal(dialog.title, "Open Remote Code")
    const code = dialog.options.find((option) => option.title.includes("ABCD-EFGH"))
    assert.ok(code)
    assert.equal(code.disabled, undefined)
    assert.ok(dialog.options.some((option) => option.value === "regenerate"))

    for (const dispose of disposers) dispose()
    assert.equal(unregisterCalled, true)
  } finally {
    if (previousDataDirectory === undefined) delete process.env.OPENCODE_REMOTE_DATA_DIR
    else process.env.OPENCODE_REMOTE_DATA_DIR = previousDataDirectory
    await rm(directory, { recursive: true, force: true })
  }
})
