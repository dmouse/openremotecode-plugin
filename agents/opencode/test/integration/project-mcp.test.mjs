import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { createProjectFixture, eventually } from "../support/opencode-project-fixture.mjs"

test("pinned MCP status reaches encrypted snapshots and subscribed updates without exposing controls", async (t) => {
  const f = await createProjectFixture(t, { mcpStatusFixture: true })
  const client = f.client(f.dirs["repo-a"])
  await eventually(async () => {
    const native = await client.mcp.status()
    assert.equal(native.response.ok, true)
    assert.equal(native.data["connected-fixture"].status, "connected")
    assert.equal(native.data["disabled-fixture"].status, "disabled")
    assert.equal(native.data["failed-fixture"].status, "failed")
  }, 25000)
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  for (const capability of ["snapshot", "subscribe", "unsubscribe", "updated"]) {
    assert.ok(connection.hello.capabilities.includes(`project.mcp.${capability}`))
  }
  const frames = []
  connection.socket.on("message", (frame) => { if (frames.length < 30) frames.push(frame.toString()) })
  const projects = await f.remoteRequest(connection, "project.list", { version: 1 })
  const projectId = projects.body.projects[0].id
  const body = { version: 1, projectId }
  const expected = [
    { name: "connected-fixture", status: "connected" },
    { name: "disabled-fixture", status: "disabled" },
    { name: "failed-fixture", status: "failed" },
  ]
  const snapshot = await f.remoteRequest(connection, "project.mcp.snapshot", body)
  assert.equal(snapshot.operation, "project.mcp.snapshot")
  assert.deepEqual(snapshot.body, { ...body, state: "ready", servers: expected })
  assert.equal(JSON.stringify(snapshot.body).includes("error"), false)
  for (const injected of [{ directory: f.dirs["repo-b"] }, { name: "connected-fixture" }, { method: "connect" }]) {
    const denied = await f.remoteRequest(connection, "project.mcp.snapshot", { ...body, ...injected })
    assert.equal(denied.body.code, "invalid_request")
  }
  const foreign = await f.remoteRequest(connection, "project.mcp.snapshot", { ...body, projectId: crypto.randomUUID() })
  assert.equal(foreign.body.code, "context_expired")
  for (const operation of ["project.mcp.connect", "project.mcp.disconnect", "project.mcp.updated", "mcp.call"]) {
    const denied = await f.remoteRequest(connection, operation, body)
    assert.equal(denied.body.code, "unsupported_operation")
  }

  const subscriptionId = crypto.randomUUID()
  const subscription = { ...body, subscriptionId }
  const initial = await f.remoteRequest(connection, "project.mcp.subscribe", subscription)
  assert.equal(initial.operation, "project.mcp.subscribe")
  assert.deepEqual(initial.body.servers, expected)
  const next = f.remoteEvent(connection, subscriptionId)
  // Only the test's local SDK changes MCP state; the remote protocol cannot.
  assert.equal((await client.mcp.disconnect({ path: { name: "connected-fixture" } })).response.ok, true)
  const update = await next
  assert.equal(update.operation, "project.mcp.updated")
  assert.equal(update.body.projectId, projectId)
  assert.equal(update.body.subscriptionId, subscriptionId)
  assert.ok(update.body.revision > initial.body.revision)
  assert.equal(update.body.state, "ready")
  assert.equal(update.body.servers.find((s) => s.name === "connected-fixture").status, "disabled")
  const renewed = await f.remoteRequest(connection, "project.mcp.subscribe", subscription)
  assert.ok(renewed.body.revision > update.body.revision)
  assert.deepEqual(renewed.body.servers, update.body.servers)
  const removed = await f.remoteRequest(connection, "project.mcp.unsubscribe", subscription)
  assert.deepEqual(removed.body, { version: 1, unsubscribed: true })
  const count = frames.length
  assert.equal((await client.mcp.connect({ path: { name: "connected-fixture" } })).response.ok, true)
  await delay(3500)
  assert.equal(frames.length, count, "Unsubscribe stops unsolicited publications")
  assert.equal(frames.some((frame) => frame.includes("connected-fixture")), false)
  assert.equal(frames.some((frame) => frame.includes("project.mcp")), false)
  assert.equal(frames.some((frame) => frame.includes(f.dirs["repo-a"])), false)

  await f.remoteRequest(connection, "project.mcp.subscribe", subscription)
  connection.socket.close()
  await eventually(() => assert.equal(f.connections.length, 2))
  const reconnected = f.connections[1]
  let pushed = 0
  reconnected.socket.on("message", () => { pushed++ })
  assert.equal((await client.mcp.disconnect({ path: { name: "connected-fixture" } })).response.ok, true)
  await delay(3500)
  assert.equal(pushed, 0, "Reconnect does not revive the previous connection's subscription")
  const nextSubscription = { ...body, subscriptionId: crypto.randomUUID() }
  const fresh = await f.remoteRequest(reconnected, "project.mcp.subscribe", nextSubscription)
  assert.equal(fresh.body.servers.find((s) => s.name === "connected-fixture").status, "disabled")
  const nextUpdate = f.remoteEvent(reconnected, nextSubscription.subscriptionId)
  assert.equal((await client.mcp.connect({ path: { name: "connected-fixture" } })).response.ok, true)
  assert.equal((await nextUpdate).body.servers.find((s) => s.name === "connected-fixture").status, "connected")
  await f.remoteRequest(reconnected, "project.mcp.unsubscribe", nextSubscription)
})
