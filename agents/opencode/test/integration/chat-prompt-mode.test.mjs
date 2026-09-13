import assert from "node:assert/strict"
import test from "node:test"
import { createProjectFixture, eventually } from "../support/opencode-project-fixture.mjs"

test("pinned runtime persists explicit prompt agents through the encrypted dispatcher", async (t) => {
  const f = await createProjectFixture(t)
  const client = f.client(f.dirs["repo-a"])
  await client.project.current()
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  assert.ok(connection.hello.capabilities.includes("chat.prompt.mode"))
  const projects = await f.remoteRequest(connection, "project.list", { version: 1 })
  const projectId = projects.body.projects[0].id
  for (const mode of ["build", "plan", undefined]) {
    const session = (await client.session.create({ body: { title: "Prompt mode fixture" } })).data
    // Seed a missing model so async execution cannot call a real provider.
    // The fixture's unmodified local default agent is Build.
    await client.session.prompt({ path: { id: session.id }, body: {
      noReply: true, agent: "plan", model: { providerID: "fixture", modelID: "fixture" },
      parts: [{ type: "text", text: "Synthetic context" }],
    } })
    const request = { version: 1, projectId, sessionId: session.id, text: "Synthetic mode request",
      ...(mode ? { mode } : {}) }
    const before = (await client.session.messages({ path: { id: session.id } })).data
    for (const override of [{ mode: "general" }, { mode: null }, { agent: "plan" },
      { mode: "plan", agent: "custom-agent" }]) {
      const invalid = await f.remoteRequest(connection, "chat.prompt", { ...request, ...override })
      assert.equal(invalid.operation, "protocol.error")
      assert.deepEqual(invalid.body, { code: "invalid_request", message: "The request body is invalid" })
    }
    assert.deepEqual((await client.session.messages({ path: { id: session.id } })).data, before,
      "Rejected prompt arguments must not create native messages")
    const response = await f.remoteRequest(connection, "chat.prompt", request)
    assert.equal(response.operation, "chat.prompt")
    assert.deepEqual(response.body, { version: 1, accepted: true })
    await eventually(async () => {
      const messages = (await client.session.messages({ path: { id: session.id } })).data
      const prompt = messages.find((m) => m.parts.some((p) => p.type === "text" && p.text === request.text))
      assert.equal(prompt?.info.agent, mode ?? "build", `Persisted agent for mode ${mode ?? "omitted"}`)
    })
    const child = (await client.session.create({ body: { parentID: session.id } })).data
    const denied = await f.remoteRequest(connection, "chat.prompt", { ...request, sessionId: child.id })
    assert.equal(denied.body.code, "access_denied")
    assert.deepEqual((await client.session.messages({ path: { id: child.id } })).data, [])
  }
  const marker = await f.remoteRequest(connection, "chat.prompt.mode", { version: 1 })
  assert.equal(marker.body.code, "unsupported_operation")
})
