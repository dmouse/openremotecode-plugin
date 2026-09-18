import assert from "node:assert/strict"
import test from "node:test"
import { chatResponses } from "@openremotecode/protocol"
import { createProjectFixture, eventually } from "../support/opencode-project-fixture.mjs"

test("OpenCode 1.18.31 encrypted rename/fork preserves full history and root-only visibility", async (t) => {
  const f = await createProjectFixture(t)
  const directory = f.dirs["repo-a"]
  const client = f.client(directory)
  const source = (await client.session.create({ body: { title: "Source fixture" } })).data
  assert.ok(source)
  const child = (await client.session.create({ body: { parentID: source.id, title: "Subagent fixture" } })).data
  // More than one remote snapshot page: a fork must not copy just the visible slice.
  for (let i = 0; i < 12; i++) {
    const result = await client.session.prompt({ path: { id: source.id }, body: {
      noReply: true, model: { providerID: "fixture", modelID: "fixture" },
      parts: [{ type: "text", text: `Synthetic history ${i}` }],
    } })
    assert.equal(result.response.status, 200)
  }
  const original = (await client.session.messages({ path: { id: source.id } })).data
  assert.equal(original.length, 12)
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  assert.ok(connection.hello.capabilities.includes("chat.rename"))
  assert.ok(connection.hello.capabilities.includes("chat.fork"))
  const request = async (operation, body, id) => f.remoteRequest(connection, operation, body, id)
  const projects = await request("project.list", { version: 1 })
  const body = { version: 1, projectId: projects.body.projects[0].id, sessionId: source.id }
  const renamed = await request("chat.rename", { ...body, title: "  Renamed fixture  " })
  assert.equal(renamed.operation, "chat.rename")
  chatResponses["chat.rename"].parse(renamed.body)
  assert.equal(renamed.body.chat.id, source.id)
  assert.equal(renamed.body.chat.title, "Renamed fixture")
  assert.equal((await client.session.get({ path: { id: source.id } })).data.title, "Renamed fixture")
  const requestId = crypto.randomUUID()
  const forked = await request("chat.fork", body, requestId)
  assert.equal(forked.operation, "chat.fork")
  chatResponses["chat.fork"].parse(forked.body)
  const forkId = forked.body.chat.id
  assert.notEqual(forkId, source.id)
  assert.equal(forked.body.chat.parentId, undefined)
  const nativeFork = (await client.session.get({ path: { id: forkId } })).data
  assert.equal(nativeFork.parentID, undefined, "Pinned forks are roots, not subagent children")
  assert.equal(nativeFork.directory, directory)
  const copy = (await client.session.messages({ path: { id: forkId } })).data
  const texts = (messages) => messages.map(({ parts }) => parts.filter((p) => p.type === "text").map((p) => p.text))
  assert.deepEqual(texts(copy), texts(original))
  assert.ok(copy.every((m) => m.info.sessionID === forkId && !original.some((o) => o.info.id === m.info.id)))
  assert.deepEqual((await client.session.messages({ path: { id: source.id } })).data, original)
  assert.deepEqual((await request("chat.fork", body, requestId)).body, forked.body)
  assert.deepEqual((await client.session.children({ path: { id: source.id } })).data.map((s) => s.id), [child.id])
  const legacy = await f.remoteSessions(connection)
  assert.deepEqual(new Set(legacy.body.sessions.map((s) => s.id)), new Set([source.id, forkId]))
  const listed = await request("chat.list", { version: 1, projectId: body.projectId })
  assert.deepEqual(new Set(listed.body.chats.map((s) => s.id)), new Set([source.id, forkId]))
  assert.equal((await request("chat.get", { ...body, sessionId: forkId })).body.chat.id, forkId)
  assert.equal((await request("chat.snapshot", { ...body, sessionId: forkId })).body.messages.length, 10)
  for (const operation of ["chat.rename", "chat.fork"]) {
    const result = await request(operation, { ...body, sessionId: child.id, ...(operation === "chat.rename" ? { title: "Denied" } : {}) })
    assert.equal(result.body.code, "access_denied")
  }
  const foreign = (await f.client(f.dirs["repo-b"]).session.create({ body: { title: "Foreign fixture" } })).data
  for (const operation of ["chat.rename", "chat.fork"]) {
    const result = await request(operation, { ...body, sessionId: foreign.id, ...(operation === "chat.rename" ? { title: "Denied" } : {}) })
    assert.equal(result.body.code, "access_denied")
  }
  // Visibility needs no process-local fork registry: it survives a fresh adapter.
  const { OpenCodeChatAdapter } = await import("../../dist/chat-adapter.js")
  const fresh = new OpenCodeChatAdapter(client, directory)
  const freshProject = (await fresh.execute("project.list", {})).projects[0].id
  assert.deepEqual(new Set((await fresh.execute("chat.list", { projectId: freshProject })).chats.map((s) => s.id)), new Set([source.id, forkId]))
  const longTitle = "x".repeat(512)
  assert.equal((await request("chat.rename", { ...body, title: longTitle })).body.chat.title, longTitle)
  const longFork = await request("chat.fork", body)
  assert.equal(longFork.operation, "chat.fork")
  assert.equal(longFork.body.chat.title.length, 512)
  assert.ok((await client.session.get({ path: { id: longFork.body.chat.id } })).data.title.length > 512)
  assert.ok((await f.remoteSessions(connection)).body.sessions.some((s) => s.id === longFork.body.chat.id))
  assert.ok((await request("chat.list", { version: 1, projectId: body.projectId })).body.chats.some((s) => s.id === longFork.body.chat.id))
})
