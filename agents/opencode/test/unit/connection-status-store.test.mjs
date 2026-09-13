import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { FileConnectorConnectionStatusStore } from "../../dist/connection-status-store.js"

test("connector connection status is atomically replaced and permission restricted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-connection-status-"))
  try {
    const filePath = path.join(directory, "connector-connection-status.json")
    const store = new FileConnectorConnectionStatusStore(filePath)

    assert.equal(await store.load(), undefined)

    const offline = { version: 1, connected: false, updatedAt: "2026-09-01T10:00:00.000Z" }
    await store.replace(offline)
    assert.deepEqual(await store.load(), offline)

    const online = { version: 1, connected: true, updatedAt: "2026-09-01T10:05:00.000Z" }
    await store.replace(online)
    assert.deepEqual(await store.load(), online)
    const contents = await readFile(filePath, "utf8")
    assert.equal(contents.includes("2026-09-01T10:00:00.000Z"), false)

    for (const invalid of [
      { version: 2, connected: true, updatedAt: online.updatedAt },
      { version: 1, connected: "yes", updatedAt: online.updatedAt },
      { version: 1, connected: true, updatedAt: "not-a-date" },
      { version: 1, connected: true, updatedAt: online.updatedAt, extra: "field" },
    ]) {
      await assert.rejects(store.replace(invalid))
    }

    await store.clear()
    assert.equal(await store.load(), undefined)

    if (process.platform !== "win32") {
      await store.replace(online)
      const { mode } = await stat(filePath)
      assert.equal(mode & 0o077, 0)
      await chmod(filePath, 0o644)
      await assert.rejects(store.load(), /0600/u)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
