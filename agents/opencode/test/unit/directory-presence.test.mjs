import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

import { announceDirectory, liveDirectories } from "../../dist/directory-presence.js"
import { WorkspaceRegistry } from "../../dist/chat/workspace.js"

async function withRoot(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opencode-remote-presence-")))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function until(condition, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return
    await delay(10)
  }
  assert.fail(message)
}

test("a running instance announces its directory and withdraws it on stop", async () => {
  await withRoot(async (root) => {
    const presence = path.join(root, "directories")
    const a = announceDirectory({ presencePath: presence, directory: "/work/a", heartbeatMs: 20 })
    const b = announceDirectory({ presencePath: presence, directory: "/work/b", heartbeatMs: 20 })
    await until(async () => (await liveDirectories(presence)).length === 2, "both directories should be announced")
    assert.deepEqual(await liveDirectories(presence), ["/work/a", "/work/b"])
    await a.stop()
    assert.deepEqual(await liveDirectories(presence), ["/work/b"])
    await b.stop()
    assert.deepEqual(await liveDirectories(presence), [])
  })
})

test("a crashed instance stops granting access once its announcement goes stale", async () => {
  await withRoot(async (root) => {
    const presence = path.join(root, "directories")
    await mkdir(presence)
    const file = path.join(presence, "dead.json")
    await writeFile(file, JSON.stringify({ version: 1, directory: "/work/dead" }))
    assert.deepEqual(await liveDirectories(presence, 400), ["/work/dead"])
    const old = new Date(Date.now() - 60_000)
    await utimes(file, old, old)
    assert.deepEqual(await liveDirectories(presence, 400), [])
  })
})

test("malformed, relative and control-character announcements are ignored", async () => {
  await withRoot(async (root) => {
    const presence = path.join(root, "directories")
    await mkdir(presence)
    await writeFile(path.join(presence, "1.json"), "not json")
    await writeFile(path.join(presence, "2.json"), JSON.stringify({ version: 1, directory: "relative/dir" }))
    await writeFile(path.join(presence, "3.json"), JSON.stringify({ version: 1, directory: "/work/\u0007bell" }))
    await writeFile(path.join(presence, "4.json"), JSON.stringify({ version: 2, directory: "/work/future" }))
    await writeFile(path.join(presence, "5.json"), JSON.stringify({ version: 1, directory: "/work/good" }))
    assert.deepEqual(await liveDirectories(presence), ["/work/good"])
  })
})

test("the registry serves announced directories and drops them when the instance exits", async () => {
  await withRoot(async (root) => {
    const own = path.join(root, "own")
    const other = path.join(root, "other")
    await mkdir(own)
    await mkdir(other)
    let announced = [other, path.join(root, "vanished")]
    const registry = new WorkspaceRegistry(own, [], async () => announced)
    const listed = await registry.list()
    assert.deepEqual(listed.map((entry) => entry.path), [own, other])
    assert.equal((await registry.resolvePath(other)).path, other)
    announced = []
    assert.deepEqual((await registry.list()).map((entry) => entry.path), [own])
    await assert.rejects(registry.get(listed[1].id), { code: "context_expired" })
  })
})

test("without discovery the registry serves only its own directory", async () => {
  await withRoot(async (root) => {
    const own = path.join(root, "own")
    await mkdir(own)
    const registry = new WorkspaceRegistry(own)
    assert.deepEqual((await registry.list()).map((entry) => entry.path), [own])
  })
})
