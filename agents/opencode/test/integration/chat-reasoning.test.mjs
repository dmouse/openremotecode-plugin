import assert from "node:assert/strict"
import test from "node:test"
import { chatResponses } from "@openremotecode/protocol"
import { createProjectFixture, eventually } from "../support/opencode-project-fixture.mjs"
import { seedReasoning } from "../support/reasoning-fixture.mjs"

test("pinned OpenCode reasoning reaches authorized encrypted snapshots without metadata", async (t) => {
  const f = await createProjectFixture(t)
  const client = f.client(f.dirs["repo-a"])
  const session = (await client.session.create({ body: { title: "Reasoning fixture" } })).data
  const user = (await client.session.prompt({ path: { id: session.id }, body: {
    noReply: true, model: { providerID: "fixture", modelID: "fixture" },
    parts: [{ type: "text", text: "Synthetic reasoning request" }],
  } })).data
  const messageId = seedReasoning(f, session.id, user.info.id)
  const native = (await client.session.message({ path: { id: session.id, messageID: messageId } })).data
  assert.equal(native.parts[0].type, "reasoning")
  assert.equal(native.parts[0].metadata.signature, "synthetic-local-only")
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  const projects = await f.remoteRequest(connection, "project.list", { version: 1 })
  const request = { version: 1, projectId: projects.body.projects[0].id, sessionId: session.id }
  const response = await f.remoteRequest(connection, "chat.snapshot", request)
  assert.equal(response.operation, "chat.snapshot")
  chatResponses["chat.snapshot"].parse(response.body)
  const message = response.body.messages.find((m) => m.id === messageId)
  assert.equal(message.text, "**Pairing is ready.**\n")
  assert.deepEqual(message.parts.map((p) => p.type), ["reasoning", "reasoning", "text"])
  assert.deepEqual(message.parts[0].time, { start: 1000, end: 9000 })
  assert.equal(message.parts[0].text, native.parts[0].text)
  assert.equal(JSON.stringify(response.body).includes("synthetic-local-only"), false)
  const foreign = (await f.client(f.dirs["repo-b"]).session.create({ body: { title: "Foreign" } })).data
  const denied = await f.remoteRequest(connection, "chat.snapshot", { ...request, sessionId: foreign.id })
  assert.equal(denied.body.code, "access_denied")
})
