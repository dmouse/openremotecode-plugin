import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { attemptQueuedRevocation, FileRevocationQueueStore } from "../../dist/auth/revocation-queue.js"

function queuedRevocation(credentialBody = "A".repeat(43)) {
  return { version: 1, serviceOrigin: "https://remote.example.test", credential: `orc_${credentialBody}` }
}

test("queued revocation is atomically persisted and permission restricted", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-revocation-"))
  try {
    const filePath = path.join(directory, "connector-revocation-queue.json")
    const store = new FileRevocationQueueStore(filePath)
    const first = queuedRevocation("A".repeat(43))
    const second = queuedRevocation("B".repeat(43))

    assert.equal(await store.load(), undefined)
    await store.replace(first)
    await store.replace(second)
    assert.deepEqual(await store.load(), second)

    if (process.platform !== "win32") {
      const { mode } = await stat(filePath)
      assert.equal(mode & 0o077, 0)
      await chmod(filePath, 0o644)
      await assert.rejects(store.load(), /0600/u)
      await chmod(filePath, 0o600)
    }

    await store.clear()
    assert.equal(await store.load(), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a queued revocation is retried and cleared once the server accepts it", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-revocation-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new FileRevocationQueueStore(path.join(directory, "connector-revocation-queue.json"))
  const queued = queuedRevocation()
  await store.replace(queued)
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.href, `${queued.serviceOrigin}/v1/connectors/self/revoke`)
    assert.equal(init.headers.Authorization, `Bearer ${queued.credential}`)
    return new Response(null, { status: 204 })
  })

  await attemptQueuedRevocation(store, new AbortController().signal)

  assert.equal(await store.load(), undefined)
})

test("a queued revocation stays queued when the server is still unreachable", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-revocation-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new FileRevocationQueueStore(path.join(directory, "connector-revocation-queue.json"))
  const queued = queuedRevocation()
  await store.replace(queued)
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }))

  await attemptQueuedRevocation(store, new AbortController().signal)

  assert.deepEqual(await store.load(), queued)
})

test("attempting a retry with nothing queued makes no request", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-revocation-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new FileRevocationQueueStore(path.join(directory, "connector-revocation-queue.json"))
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not send a request"))

  await attemptQueuedRevocation(store, new AbortController().signal)
})
