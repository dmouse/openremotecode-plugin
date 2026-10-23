import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

import { announceDirectory, liveDirectories, liveSessionIds } from "../../dist/directory-presence.js"
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

test("local TUI session announcements follow tab changes, are directory-scoped, and expire", async () => {
  await withRoot(async (root) => {
    const presence = path.join(root, "directories")
    const own = path.join(root, "own"); await mkdir(own)
    const other = path.join(root, "other"); await mkdir(other)
    let ids = ["ses_a"]
    const a = announceDirectory({ presencePath: presence, directory: own, heartbeatMs: 20, sessionIds: () => ids })
    const b = announceDirectory({ presencePath: presence, directory: other, heartbeatMs: 20, sessionIds: () => ["ses_foreign"] })
    try {
      await until(async () => (await liveSessionIds(presence, own)).includes("ses_a"), "open session should be announced")
      ids = ["ses_b", "ses_b"]
      await until(async () => (await liveSessionIds(presence, own)).join() === "ses_b", "tab changes should be announced")
      assert.deepEqual(await liveSessionIds(presence, other), ["ses_foreign"])
    } finally {
      await a.stop(); await b.stop()
    }
    assert.deepEqual(await liveSessionIds(presence, own), [])
  })
})

test("hostile session announcements cannot grant arbitrary IDs or resurrect stale sessions", async () => {
  await withRoot(async (root) => {
    const presence = path.join(root, "directories"); await mkdir(presence)
    for (const [name, ids] of [["invalid", ["ses_ok", "../outside"]], ["oversize", Array(65).fill("ses_ok")],
      ["wrong-type", "ses_ok"], ["stale", ["ses_stale"]]]) {
      const file = path.join(presence, `${name}.json`)
      await writeFile(file, JSON.stringify({ version: 1, directory: root, sessionIds: ids }))
      if (name === "stale") {
        const old = new Date(Date.now() - 60_000); await utimes(file, old, old)
      }
    }
    assert.deepEqual(await liveSessionIds(presence, root), [])
  })
})
