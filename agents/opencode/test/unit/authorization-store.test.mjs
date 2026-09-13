import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { generateConnectorIdentity } from "@openremotecode/protocol"
import { FileConnectorAuthorizationStore } from "../../dist/auth/authorization-store.js"

test("connector authorization is atomically replaced and permission restricted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-authorization-"))
  try {
    const filePath = path.join(directory, "connector-authorization.json")
    const store = new FileConnectorAuthorizationStore(filePath)
    const client = await generateConnectorIdentity()
    const first = authorization(client.identity.publicIdentity, "A".repeat(43))
    const second = authorization(client.identity.publicIdentity, "B".repeat(43))

    assert.equal(await store.load(), undefined)
    await store.replace(first)
    await store.replace(second)
    assert.deepEqual(await store.load(), second)
    const contents = await readFile(filePath, "utf8")
    assert.equal(contents.includes(first.credential), false)

    const linked = { ...second, linkedAt: "2026-09-01T10:30:00.000Z" }
    await store.replace(linked)
    assert.deepEqual(await store.load(), linked)
    for (const linkedAt of [null, 123, "invalid"]) {
      await assert.rejects(store.replace({ ...second, linkedAt }), /linkedAt/u)
    }

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

function authorization(trustedClient, tokenBody) {
  return {
    version: 1,
    serviceOrigin: "https://remote.example.test",
    connectorId: "con_0123456789abcdefghijklmn",
    connectorKeyId: "c".repeat(43),
    credential: `orc_${tokenBody}`,
    credentialExpiresAt: "2027-01-01T00:00:00.000Z",
    trustedClient,
  }
}
