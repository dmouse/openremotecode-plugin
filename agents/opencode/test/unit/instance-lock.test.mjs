import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

import { superviseOwnership } from "../../dist/instance-lock.js"

const timing = { heartbeatMs: 20, staleAfterMs: 400, pollMs: 20 }

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-instance-lock-"))
  try {
    await run(directory, path.join(directory, "connector-instance.lock"))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function contender(lockPath, events, name, overrides = {}) {
  return superviseOwnership({
    lockPath,
    ...timing,
    onAcquired: async () => { events.push(`${name}:acquired`) },
    onLost: async () => { events.push(`${name}:lost`) },
    onStandby: () => { events.push(`${name}:standby`) },
    ...overrides,
  })
}

async function until(condition, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await delay(10)
  }
  assert.fail(message)
}

test("only one of several instances becomes the owner, and the others report standby once", async () => {
  await withDirectory(async (_directory, lockPath) => {
    const events = []
    const instances = ["a", "b", "c"].map((name) => contender(lockPath, events, name))
    try {
      await until(() => events.filter((event) => event.endsWith(":standby")).length === 2, "two instances should be standing by")
      await delay(150)
      assert.equal(events.filter((event) => event.endsWith(":acquired")).length, 1)
      assert.equal(events.filter((event) => event.endsWith(":standby")).length, 2)
      assert.equal(events.some((event) => event.endsWith(":lost")), false)
      const info = await stat(lockPath)
      assert.equal(info.mode & 0o077, 0)
    } finally {
      await Promise.all(instances.map((instance) => instance.stop()))
    }
  })
})

test("a standby instance takes over when the owner stops, and stopping releases the lock", async () => {
  await withDirectory(async (directory, lockPath) => {
    const events = []
    const first = contender(lockPath, events, "first")
    await until(() => events.includes("first:acquired"), "first should own the lock")
    const second = contender(lockPath, events, "second")
    await until(() => events.includes("second:standby"), "second should stand by")

    await first.stop()
    assert.ok(events.includes("first:lost"), "stopping the owner tears its work down")
    await until(() => events.includes("second:acquired"), "second should take over")
    assert.deepEqual(events.filter((event) => event.endsWith(":acquired")), ["first:acquired", "second:acquired"])

    await second.stop()
    assert.deepEqual((await readdir(directory)).filter((name) => name.includes("lock")), [])
  })
})

test("a lock left by a crashed owner goes stale and is taken over", async () => {
  await withDirectory(async (_directory, lockPath) => {
    await writeFile(lockPath, `${JSON.stringify({ version: 1, token: "dead", pid: 1, acquiredAt: "2026-09-01T00:00:00.000Z" })}\n`, { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)

    const events = []
    const instance = contender(lockPath, events, "survivor")
    try {
      await until(() => events.includes("survivor:acquired"), "a stale lock must not block every later instance")
      assert.notEqual(JSON.parse(await readFile(lockPath, "utf8")).token, "dead")
    } finally {
      await instance.stop()
    }
  })
})

test("a fresh lock held by another instance is never taken over", async () => {
  await withDirectory(async (_directory, lockPath) => {
    await writeFile(lockPath, `${JSON.stringify({ version: 1, token: "other", pid: 1, acquiredAt: "2026-09-01T00:00:00.000Z" })}\n`, { mode: 0o600 })
    const events = []
    const instance = contender(lockPath, events, "waiting")
    try {
      await delay(200)
      assert.deepEqual(events, ["waiting:standby"])
    } finally {
      await instance.stop()
    }
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "other", "stopping a standby instance must not remove another's lock")
  })
})

test("an owner that lost the lock while suspended stops its work instead of contending", async () => {
  await withDirectory(async (_directory, lockPath) => {
    const events = []
    const owner = contender(lockPath, events, "owner")
    await until(() => events.includes("owner:acquired"), "owner should hold the lock")

    // Another instance judged the lock stale (for example after the machine slept) and replaced it.
    await writeFile(lockPath, `${JSON.stringify({ version: 1, token: "usurper", pid: 2, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 })
    try {
      await until(() => events.includes("owner:lost"), "the displaced owner must stop its relay")
      assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "usurper")
    } finally {
      await owner.stop()
    }
    assert.equal(events.filter((event) => event === "owner:lost").length, 1)
  })
})

test("a failure while starting the owner's work releases the lock for the others", async () => {
  await withDirectory(async (_directory, lockPath) => {
    const events = []
    let failures = 1
    const broken = contender(lockPath, events, "broken", {
      onAcquired: async () => {
        events.push("broken:acquired")
        if (failures-- > 0) throw new Error("startup failed")
      },
    })
    const healthy = contender(lockPath, events, "healthy")
    try {
      await until(() => events.includes("healthy:acquired") || events.filter((event) => event === "broken:acquired").length > 1,
        "the lock must not stay with an instance that failed to start")
    } finally {
      await Promise.all([broken.stop(), healthy.stop()])
    }
  })
})
