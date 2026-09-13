import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { FileConnectorIdentityStore } from "../../dist/crypto/identity-store.js"

test("connector identity is created atomically and reused", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "opencode-identity-"))
  const identityPath = path.join(temporaryRoot, "keys", "connector-identity.json")

  try {
    const identities = await Promise.all(
      Array.from({ length: 4 }, () =>
        new FileConnectorIdentityStore(identityPath).loadOrCreate(),
      ),
    )
    const keyIds = new Set(
      identities.map((identity) => identity.publicIdentity.keyId),
    )
    assert.equal(keyIds.size, 1)

    const persisted = JSON.parse(await readFile(identityPath, "utf8"))
    assert.equal(persisted.keyId, identities[0].publicIdentity.keyId)
    assert.equal(typeof persisted.privateKey, "string")

    if (process.platform !== "win32") {
      const file = await stat(identityPath)
      assert.equal(file.mode & 0o777, 0o600)
    }

    const loaded = await new FileConnectorIdentityStore(identityPath).loadOrCreate()
    assert.deepEqual(loaded.publicIdentity, identities[0].publicIdentity)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("connector identity refuses permissive private-key file permissions", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX file modes are not available on Windows")
    return
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "opencode-identity-"))
  const identityPath = path.join(temporaryRoot, "keys", "connector-identity.json")

  try {
    await new FileConnectorIdentityStore(identityPath).loadOrCreate()
    await chmod(identityPath, 0o644)
    await assert.rejects(
      new FileConnectorIdentityStore(identityPath).loadOrCreate(),
      /permissions must be 0600/u,
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
