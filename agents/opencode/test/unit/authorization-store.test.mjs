import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

test("an authorization written before rotation upgrades in place", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-authorization-v1-"))
  try {
    const filePath = path.join(directory, "connector-authorization.json")
    const store = new FileConnectorAuthorizationStore(filePath)
    const client = await generateConnectorIdentity()
    const existing = { ...authorization(client.identity.publicIdentity, "A".repeat(43)), version: 1 }

    // A file left by an earlier plugin version must keep working: rejecting it here would
    // force every paired connector through the safety-code ceremony again.
    await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 })
    const loaded = await store.load()
    assert.equal(loaded.version, 2)
    assert.equal(loaded.credential, existing.credential)
    assert.equal(loaded.pending, undefined)
    assert.deepEqual({ ...loaded, version: 1 }, existing)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a pending credential round-trips and is validated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-authorization-pending-"))
  try {
    const filePath = path.join(directory, "connector-authorization.json")
    const store = new FileConnectorAuthorizationStore(filePath)
    const client = await generateConnectorIdentity()
    const base = authorization(client.identity.publicIdentity, "A".repeat(43))
    const staged = {
      ...base,
      pending: { credential: `orc_${"N".repeat(43)}`, activateBy: "2026-09-14T12:15:00.000Z" },
    }

    await store.replace(staged)
    assert.deepEqual(await store.load(), staged)

    // Both credentials are on disk at once, which is what survives a crash mid-rotation.
    const contents = await readFile(filePath, "utf8")
    assert.equal(contents.includes(base.credential) && contents.includes(staged.pending.credential), true)

    for (const pending of [
      null,
      {},
      { credential: `orc_${"N".repeat(43)}` },
      { credential: "not-a-credential", activateBy: "2026-09-14T12:15:00.000Z" },
      { credential: `orc_${"N".repeat(43)}`, activateBy: "nonsense" },
      { credential: `orc_${"N".repeat(43)}`, activateBy: "2026-09-14T12:15:00.000Z", extra: true },
    ]) {
      await assert.rejects(store.replace({ ...base, pending }), /[Pp]ending/u)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function authorization(trustedClient, tokenBody) {
  return {
    version: 2,
    serviceOrigin: "https://remote.example.test",
    connectorId: "con_0123456789abcdefghijklmn",
    connectorKeyId: "c".repeat(43),
    credential: `orc_${tokenBody}`,
    credentialExpiresAt: "2027-01-01T00:00:00.000Z",
    trustedClient,
  }
}
