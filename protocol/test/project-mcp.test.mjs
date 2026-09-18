import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { PROJECT_MCP_CAPABILITIES, chatRequests, chatResponses, projectMcpRequests, projectMcpResponses,
  projectMcpServerSchema, projectMcpSnapshotSchema, projectMcpUpdatedSchema, projectMcpUpdatedEventSchema } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/project-mcp-v1.json", import.meta.url), "utf8"))

test("shared MCP v1 fixtures are separate strict contracts, including the non-callable event marker", () => {
  for (const [operation, request, response] of [
    ["project.mcp.snapshot", fixture.snapshotRequest, fixture.snapshotResponse],
    ["project.mcp.subscribe", fixture.subscribeRequest, fixture.update],
    ["project.mcp.unsubscribe", fixture.subscribeRequest, { version: 1, unsubscribed: true }],
  ]) {
    assert.deepEqual(projectMcpRequests[operation].parse(request), request)
    assert.deepEqual(projectMcpResponses[operation].parse(response), response)
    for (const override of [{ version: 2 }, { projectId: "/private" }, { directory: "/private" }, { url: "https://private.invalid" },
      { command: "execute" }, { config: {} }, { error: "secret" }, { args: [] }]) {
      assert.equal(projectMcpRequests[operation].safeParse({ ...request, ...override }).success, false)
    }
  }
  assert.deepEqual(PROJECT_MCP_CAPABILITIES, ["project.mcp.snapshot", "project.mcp.subscribe", "project.mcp.unsubscribe", "project.mcp.updated"])
  assert.equal(projectMcpRequests["project.mcp.updated"], undefined)
  assert.equal(chatRequests["project.mcp.snapshot"], undefined)
  assert.equal(chatResponses["project.mcp.snapshot"], undefined)
  for (const subscriptionId of [null, "", "not-a-uuid"]) {
    assert.equal(projectMcpRequests["project.mcp.subscribe"].safeParse({ ...fixture.subscribeRequest, subscriptionId }).success, false)
  }
})

test("server names enforce UTF-16 bounds, C0/C1 and every prohibited bidi control", () => {
  const controls = [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127),
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
  const valid = (name) => projectMcpServerSchema.safeParse({ name, status: "connected" }).success
  for (const code of controls) assert.equal(valid(`server${String.fromCharCode(code)}name`), false, `U+${code.toString(16)}`)
  for (const name of ["", "a".repeat(129), "\u{1f600}".repeat(65)]) assert.equal(valid(name), false)
  for (const name of ["context7", "a".repeat(128), "\u{1f600}".repeat(64), "__proto__"]) assert.equal(valid(name), true)
})

test("snapshots never accept raw fields, unknown status, duplicates, overflow or unavailable data", () => {
  for (const schema of [projectMcpSnapshotSchema, projectMcpUpdatedSchema]) {
    const base = schema === projectMcpSnapshotSchema ? fixture.snapshotResponse : fixture.update
    for (const override of [{ raw: {} }, { error: "native error" }, { state: "loading" }, { version: 2 },
      { state: "unavailable" }, { servers: [{ name: "server", status: "unknown" }] },
      { servers: [{ name: "server", status: "failed", error: "native error" }] },
      { servers: [{ name: "server", status: "connected", config: { url: "https://secret.invalid" } }] },
      { servers: Array(2).fill(base.servers[0]) },
      { servers: Array.from({ length: 101 }, (_, i) => ({ name: `server-${i}`, status: "disabled" })) },
    ]) assert.equal(schema.safeParse({ ...base, ...override }).success, false)
    assert.equal(schema.safeParse({ ...base, servers: [] }).success, true)
    assert.equal(schema.safeParse({ ...base, state: "unavailable", servers: [] }).success, true)
    assert.equal(schema.safeParse({ ...base, servers: Array.from({ length: 100 }, (_, i) => ({ name: `server-${i}`, status: "disabled" })) }).success, true)
  }
})

test("updates require safe nonnegative revisions and envelope requestId equals subscriptionId", () => {
  for (const revision of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.equal(projectMcpUpdatedSchema.safeParse({ ...fixture.update, revision }).success, false)
  }
  for (const revision of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(projectMcpUpdatedSchema.safeParse({ ...fixture.update, revision }).success, true)
  }
  const event = { protocolVersion: 2, kind: "event", operation: "project.mcp.updated",
    requestId: fixture.update.subscriptionId, sentAt: 1, body: fixture.update }
  assert.deepEqual(projectMcpUpdatedEventSchema.parse(event), event)
  for (const override of [{ kind: "response" }, { requestId: fixture.update.projectId }, { operation: "project.mcp.subscribe" }, { raw: {} }]) {
    assert.equal(projectMcpUpdatedEventSchema.safeParse({ ...event, ...override }).success, false)
  }
})
