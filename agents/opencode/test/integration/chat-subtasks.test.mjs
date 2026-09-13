import assert from "node:assert/strict"
import test from "node:test"
import { chatResponses } from "@openremotecode/protocol"
import { createProjectFixture, eventually } from "../support/opencode-project-fixture.mjs"
import { seedSubtask } from "../support/subtask-fixture.mjs"

test("pinned child sessions render through the encrypted relay and enforce parent/workspace isolation", async (t) => {
  const f = await createProjectFixture(t)
  const client = f.client(f.dirs["repo-a"])
  await eventually(async () => assert.equal((await client.session.status()).response.status, 200), 25000)
  const parent = (await client.session.create({ body: { title: "Task parent fixture" } })).data
  const child = (await client.session.create({ body: { parentID: parent.id, title: "Palette subtask fixture" } })).data
  const user = (await client.session.prompt({ path: { id: parent.id }, body: {
    noReply: true, model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Synthetic palette request" }],
  } })).data
  seedSubtask(f, parent.id, child.id, user.info.id)
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  assert.ok(connection.hello.capabilities.includes("chat.subtask.snapshot"))
  const projects = await f.remoteRequest(connection, "project.list", { version: 1 })
  const body = { version: 1, projectId: projects.body.projects[0].id, sessionId: parent.id }
  const plain = await f.remoteRequest(connection, "chat.snapshot", body)
  assert.ok(plain.body.messages.some((m) => m.text.includes("[Tool: task")))
  const result = await f.remoteRequest(connection, "chat.snapshot", { ...body, includeSubtasks: true })
  assert.equal(result.operation, "chat.snapshot")
  chatResponses["chat.snapshot"].parse(result.body)
  const task = result.body.messages.flatMap((m) => m.parts ?? []).find((p) => p.type === "subtask").task
  assert.equal(task.sessionId, child.id)
  assert.deepEqual(task.stats, { toolCalls: 15, complete: true, durationMs: 82000 })
  assert.equal(JSON.stringify(result.body).includes("synthetic-local-only"), false)
  const request = { ...body, sessionId: child.id, parentSessionId: parent.id }
  const snapshot = await f.remoteRequest(connection, "chat.subtask.snapshot", request)
  assert.equal(snapshot.operation, "chat.subtask.snapshot")
  chatResponses["chat.subtask.snapshot"].parse(snapshot.body)
  assert.equal(snapshot.body.chat.parentId, parent.id)
  assert.ok(snapshot.body.messages.some((m) => m.text.includes("deep green")))
  assert.equal(JSON.stringify(snapshot.body).includes("synthetic-local-only"), false)
  const fork = await f.remoteRequest(connection, "chat.fork", body)
  assert.equal(fork.operation, "chat.fork")
  const forked = await f.remoteRequest(connection, "chat.snapshot", { ...body, sessionId: fork.body.chat.id, includeSubtasks: true })
  assert.deepEqual(forked.body.messages.map((m) => [m.role, m.text]), result.body.messages.map((m) => [m.role, m.text]))
  // Copied task metadata does not grant access to the original parent's child.
  const copied = forked.body.messages.flatMap((m) => m.parts ?? []).find((p) => p.type === "subtask").task
  assert.equal(copied.sessionId, undefined)
  const unrelated = (await client.session.create({ body: { title: "Unrelated fixture" } })).data
  const foreign = (await f.client(f.dirs["repo-b"]).session.create({ body: { parentID: parent.id, title: "Foreign fixture" } })).data
  for (const extra of [{ parentSessionId: unrelated.id }, { sessionId: foreign.id }, { sessionId: parent.id }]) {
    const denied = await f.remoteRequest(connection, "chat.subtask.snapshot", { ...request, ...extra })
    assert.equal(denied.body.code, "access_denied")
  }
  for (const operation of ["chat.snapshot", "chat.prompt", "chat.abort"]) {
    const denied = await f.remoteRequest(connection, operation, { ...body, sessionId: child.id,
      ...(operation === "chat.prompt" ? { text: "Must not send" } : {}) })
    assert.equal(denied.body.code, "access_denied")
  }
  await client.session.delete({ path: { id: child.id } })
  const afterDelete = await f.remoteRequest(connection, "chat.snapshot", { ...body, includeSubtasks: true })
  const missing = afterDelete.body.messages.flatMap((m) => m.parts ?? []).find((p) => p.type === "subtask").task
  assert.equal(missing.sessionId, undefined)
  const gone = await f.remoteRequest(connection, "chat.subtask.snapshot", request)
  assert.equal(gone.body.code, "chat_not_found")
})
