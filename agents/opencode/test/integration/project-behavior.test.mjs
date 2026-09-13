import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import test from "node:test"

import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2/client"
import { createProjectFixture, eventually } from "../support/opencode-project-fixture.mjs"

// Characterization of the real pinned dependency, including unsafe behavior
// the future remote adapter must reject. These are not authorization tests.
test("OpenCode 1.18.30 project and session compatibility", async (t) => {
  const f = await createProjectFixture(t)
  const names = ["repo-a", "repo-b", "worktree", "plain-a", "plain-b"]
  const sessions = {}
  const projects = {}
  const a = f.client(f.dirs["repo-a"])

  // Shared setup fails the parent once, instead of cascading into unrelated
  // undefined-session failures in every subsequent behavior check.
  assert.deepEqual(await f.records(), [])
  for (const name of names) {
    const client = f.client(f.dirs[name])
    projects[name] = sdkData(await client.project.current())
    sessions[name] = sdkData(await client.session.create({ body: { title: `Fixture ${name}` } }))
    assert.equal(sessions[name].directory, f.dirs[name])
    assert.equal(sessions[name].projectID, projects[name].id)
    assert.equal(sessions[name].version, "1.18.30")
  }

  await t.test("directory activation initializes global and project-local plugins", async () => {
    await eventually(async () => {
      const records = await f.records()
      assert.equal(records.filter((r) => r.kind === "init").length, names.length)
      assert.deepEqual(records.filter((r) => r.kind === "project-config").map((r) => r.directory), [f.dirs["repo-b"]])
      assert.equal(f.connections.length, names.length)
    })
    // Production currently registers by (account, keyId), so these sockets
    // cannot yet be routed independently there.
    assert.equal(new Set(f.connections.map((c) => c.hello.identity.keyId)).size, 1)
  })

  await t.test("worktrees share a project ID; non-Git folders share global", async () => {
    assert.notEqual(projects["repo-a"].id, projects["repo-b"].id)
    assert.equal(projects.worktree.id, projects["repo-a"].id)
    assert.equal(projects["plain-a"].id, "global")
    assert.equal(projects["plain-b"].id, "global")
    const known = sdkData(await a.project.list())
    assert.equal(known.length, 3)
    assert.ok(known.some((p) => p.id === "global"))
    const init = (await f.records()).find((r) => r.kind === "init" && r.directory === f.dirs["plain-a"])
    assert.equal(init.worktree, "/", "Non-Git worktree is not a safe authorization root")
  })

  await t.test("SDK and encrypted relay listing stay scoped to each directory", async () => {
    for (const name of names) {
      const listed = sdkData(await f.client(f.dirs[name]).session.list())
      assert.deepEqual(listed.map((s) => s.id), [sessions[name].id])
    }
    const override = sdkData(await a.session.list({ query: { directory: f.dirs["repo-b"] } }))
    assert.deepEqual(override.map((s) => s.id), [sessions["repo-b"].id])
    const relayed = []
    for (const connection of f.connections) {
      const response = await f.remoteSessions(connection)
      assert.equal(response.operation, "session.list")
      assert.equal(response.body.sessions.length, 1)
      relayed.push(response.body.sessions[0].id)
    }
    assert.deepEqual(new Set(relayed), new Set(Object.values(sessions).map((s) => s.id)))
    const broader = httpData(await f.request(f.dirs["repo-a"], "/session", { query: { scope: "project" } }))
    assert.deepEqual(new Set(broader.map((s) => s.id)), new Set([sessions["repo-a"].id, sessions.worktree.id]))
  })

  await t.test("session ID lookup does not enforce the supplied directory", async () => {
    for (const name of ["repo-b", "worktree", "plain-a"]) {
      const foreign = sdkData(await f.client(f.dirs[name]).session.get({ path: { id: sessions["repo-a"].id } }))
      assert.equal(foreign.id, sessions["repo-a"].id)
      assert.equal(foreign.directory, f.dirs["repo-a"])
    }
    const unknown = await a.session.get({ path: { id: "ses_does_not_exist" } })
    assert.equal(unknown.response.status, 404)
  })

  await t.test("session creation needs no provider; children remain separately discoverable", async () => {
    const parent = sessions["repo-a"]
    const child = sdkData(await a.session.create({ body: { parentID: parent.id, title: "Fixture child" } }))
    assert.equal(child.parentID, parent.id)
    assert.equal(child.directory, f.dirs["repo-a"])
    const children = sdkData(await a.session.children({ path: { id: parent.id } }))
    assert.deepEqual(children.map((s) => s.id), [child.id])
    const all = sdkData(await a.session.list())
    assert.deepEqual(new Set(all.map((s) => s.id)), new Set([parent.id, child.id]))
    const roots = httpData(await f.request(f.dirs["repo-a"], "/session", { query: { roots: true } }))
    assert.deepEqual(roots.map((s) => s.id), [parent.id])
    assert.deepEqual(sdkData(await a.session.messages({ path: { id: parent.id } })), [])
    assert.deepEqual(sdkData(await a.session.status()), {}, "Idle sessions are absent from the status map")
  })

  await t.test("the legacy list silently caps at 100; cursor pages reach the full list", async () => {
    for (let i = 0; i < 105; i++) {
      sdkData(await a.session.create({ body: { title: `Fixture page ${String(i).padStart(3, "0")}` } }))
    }
    assert.equal(sdkData(await a.session.list()).length, 100)
    const all = httpData(await f.request(f.dirs["repo-a"], "/session", { query: { limit: 200 } }))
    assert.equal(all.length, 107)
    assert.ok(all.every((s) => s.directory === f.dirs["repo-a"]))
    assert.ok(all.every((s, i) => i === 0 || all[i - 1].time.updated >= s.time.updated))
    const v2 = createV2Client({ baseUrl: f.origin,
      fetch: (request) => fetch(request, { signal: AbortSignal.timeout(10_000) }) })
    const ids = []
    let cursor
    let exhausted = false
    for (let page = 0; page < 10; page++) {
      const result = sdkData(await v2.v2.session.list({ directory: f.dirs["repo-a"], limit: 23, ...(cursor ? { cursor } : {}) }))
      assert.ok(result.data.length <= 23)
      assert.ok(result.data.every((s) => s.location.directory === f.dirs["repo-a"]))
      ids.push(...result.data.map((s) => s.id))
      cursor = result.cursor.next
      if (!cursor) { exhausted = true; break }
    }
    assert.equal(exhausted, true, "Cursor traversal must terminate")
    assert.equal(ids.length, new Set(ids).size, "Static pages must not duplicate sessions")
    assert.deepEqual(new Set(ids), new Set(all.map((s) => s.id)))
    const plain = sdkData(await v2.v2.session.list({ directory: f.dirs["plain-a"], limit: 23 }))
    assert.deepEqual(plain.data.map((s) => s.id), [sessions["plain-a"].id])
    // Nonempty final pages still have next; an empty page supplies null cursors.
    assert.equal(typeof plain.cursor.next, "string")
    const end = sdkData(await v2.v2.session.list({ directory: f.dirs["plain-a"], limit: 23, cursor: plain.cursor.next }))
    assert.deepEqual(end, { data: [], cursor: { previous: null, next: null } })
  })

  await t.test("message history uses the returned cursor, not a message ID", async () => {
    const id = sessions["repo-a"].id
    const expected = []
    for (let i = 0; i < 5; i++) {
      const message = sdkData(await a.session.prompt({ path: { id }, body: {
        noReply: true, model: { providerID: "fixture", modelID: "fixture" },
        parts: [{ type: "text", text: `Synthetic fixture message ${i}` }],
      } }))
      expected.push(message.info.id)
    }
    const route = `/session/${id}/message`
    const first = await f.request(f.dirs["repo-a"], route, { query: { limit: 2 } })
    assert.deepEqual(httpData(first).map((m) => m.info.id), expected.slice(-2))
    const seen = first.data.map((m) => m.info.id)
    let cursor = first.headers.get("x-next-cursor")
    assert.equal(typeof cursor, "string")
    for (let page = 0; cursor && page < 5; page++) {
      const older = await f.request(f.dirs["repo-a"], route, { query: { limit: 2, before: cursor } })
      seen.unshift(...httpData(older).map((m) => m.info.id))
      cursor = older.headers.get("x-next-cursor")
    }
    assert.equal(cursor, null)
    assert.deepEqual(seen, expected)
    const invalid = await f.request(f.dirs["repo-a"], route, { query: { limit: 2, before: expected[0] } })
    assert.equal(invalid.status, 400)
    const foreign = sdkData(await f.client(f.dirs["repo-b"]).session.messages({ path: { id } }))
    assert.deepEqual(foreign.map((m) => m.info.id), expected, "Message access also needs membership checks")
  })

  await t.test("async failures emit scoped busy, error, and idle events", async () => {
    const id = sessions["repo-a"].id
    // Absent provider, no credentials, and all providers disabled: no model call.
    const response = await a.session.promptAsync({ path: { id }, body: {
      model: { providerID: "fixture", modelID: "fixture" },
      parts: [{ type: "text", text: "Synthetic provider failure" }],
    } })
    assert.equal(response.response.status, 204)
    await eventually(async () => {
      const events = (await f.records()).filter((r) => r.sessionId === id)
      assert.ok(events.some((r) => r.type === "session.error"))
      assert.ok(events.some((r) => r.status === "busy"))
      assert.ok(events.some((r) => r.status === "idle"))
    })
    const records = await f.records()
    for (const name of names) {
      const events = records.filter((r) => r.sessionId === sessions[name].id)
      assert.ok(events.some((r) => r.type === "session.created"))
      assert.ok(events.every((r) => r.directory === f.dirs[name]))
    }
    assert.deepEqual(sdkData(await a.session.status()), {})
  })

  await t.test("unknown folders activate; nonexistent paths are not rejected by OpenCode", async () => {
    for (const name of ["unopened", "missing"]) {
      const client = f.client(f.dirs[name])
      assert.equal(sdkData(await client.project.current()).id, "global")
      const session = sdkData(await client.session.create({ body: { title: `Fixture ${name}` } }))
      assert.equal(session.directory, f.dirs[name])
      assert.deepEqual(sdkData(await client.session.list()).map((s) => s.id), [session.id])
    }
    await assert.rejects(stat(f.dirs.missing), { code: "ENOENT" })
    const file = await f.request(f.dirs.file, "/project/current")
    assert.equal(file.status, 500)
    const records = await f.records()
    assert.ok(records.some((r) => r.kind === "init" && r.directory === f.dirs.missing))
    assert.ok(!records.some((r) => r.kind === "init" && r.directory === f.dirs.file))
  })

  await t.test("disposing one directory closes its relay; reopening restores identity and sessions", async () => {
    const originalKey = f.connections[0].hello.identity.keyId
    const oldConnections = f.connections.length
    const before = sdkData(await a.session.list()).map((s) => s.id)
    assert.equal(httpData(await f.request(f.dirs["repo-a"], "/instance/dispose", { method: "POST" })), true)
    await eventually(async () => {
      assert.deepEqual((await f.records()).filter((r) => r.kind === "dispose").map((r) => r.directory), [f.dirs["repo-a"]])
      assert.equal(f.connections.filter((c) => c.socket.readyState === 3).length, 1)
    })
    assert.equal(f.connections.filter((c) => c.socket.readyState === 1).length, oldConnections - 1)
    assert.deepEqual(sdkData(await a.session.list()).map((s) => s.id), before)
    await eventually(() => assert.equal(f.connections.length, oldConnections + 1))
    const reopened = f.connections.at(-1)
    assert.equal(reopened.hello.identity.keyId, originalKey)
    const mainIds = sdkData(await a.session.list()).filter((s) => !s.parentID).map((s) => s.id)
    assert.deepEqual((await f.remoteSessions(reopened)).body.sessions.map((s) => s.id), mainIds)
  })
})

function sdkData(result) {
  assert.equal(result.error, undefined, "OpenCode SDK request failed")
  assert.equal(result.response.status, 200)
  return result.data
}

function httpData(result) {
  assert.equal(result.status, 200)
  return result.data
}
