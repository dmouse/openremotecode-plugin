import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { FileConnectorPairingStore } from "../../dist/auth/pairing-store.js"

test("pending connector pairing is atomically persisted and permission restricted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-pairing-"))
  try {
    const filePath = path.join(directory, "connector-pairing.json")
    const store = new FileConnectorPairingStore(filePath)
    const first = pendingPairing("A".repeat(43))
    const second = pendingPairing("B".repeat(43))

    assert.equal(await store.load(), undefined)
    await store.replace(first)
    await store.replace(second)
    assert.deepEqual(await store.load(), second)
    assert.equal((await readFile(filePath, "utf8")).includes(first.pairingSecret), false)

    if (process.platform !== "win32") {
      const { mode } = await import("node:fs/promises").then(({ stat }) => stat(filePath))
      assert.equal(mode & 0o077, 0)
      await chmod(filePath, 0o644)
      await assert.rejects(store.load(), /0600/u)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function pendingPairing(secretBody) {
  return {
    version: 1,
    serviceOrigin: "https://remote.example.test",
    connectorKeyId: "c".repeat(43),
    pairingId: "par_0123456789abcdefghijklmn",
    pairingSecret: `orp_${secretBody}`,
    userCode: "ABCD-EFGH",
    serviceId: "test-service",
    verificationUri: "https://remote.example.test/pair",
    expiresAt: "2027-01-01T00:00:00.000Z",
    pollIntervalSeconds: 2,
  }
}
