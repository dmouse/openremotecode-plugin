import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"
import { readProjectMcp } from "../../dist/project-mcp.js"

const fixture = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/project-mcp-v1.json", import.meta.url), "utf8"))
const secret = "synthetic-native-only-secret"

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "project-mcp-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, "project"), other = path.join(root, "other")
  await mkdir(directory); await mkdir(other)
  const state = { calls: [], data: {}, error: undefined, ok: true, beforeReturn: async () => {} }
  const client = { mcp: { status: async (options) => {
    state.calls.push(options)
    await state.beforeReturn()
    return { response: { ok: state.ok }, data: state.data, error: state.error }
  } } }
  const adapter = new OpenCodeChatAdapter(client, directory)
  const { projects } = await adapter.execute("project.list", {})
  return { adapter, state, directory, other, projectId: projects[0].id,
    read: (signal = new AbortController().signal) => readProjectMcp(adapter, projects[0].id, signal) }
}

test("MCP status uses the supplied SDK/registry and projects only name and status, never native secrets", async (t) => {
  const f = await setup(t)
  f.state.data = Object.fromEntries(fixture.snapshotResponse.servers.map(({ name, status }) => [name,
    { status, error: secret, url: `https://${secret}.invalid`, config: { command: [secret], environment: { KEY: secret } }, args: [secret] }]))
  const snapshot = await f.read()
  assert.deepEqual(snapshot, { ...fixture.snapshotResponse, projectId: f.projectId,
    servers: [...fixture.snapshotResponse.servers].sort((a, b) => a.name < b.name ? -1 : 1) })
  assert.equal(JSON.stringify(snapshot).includes(secret), false)
  assert.deepEqual(Object.keys(f.state.calls[0]).sort(), ["query", "signal"])
  assert.deepEqual(f.state.calls[0].query, { directory: f.directory })
  assert.ok(f.state.calls[0].signal instanceof AbortSignal)
  f.state.data = Object.fromEntries(Object.entries(f.state.data).reverse())
  assert.deepEqual(await f.read(), snapshot, "Native property order must not cause status changes")
  f.state.data = {}
  assert.deepEqual(await f.read(), { version: 1, projectId: f.projectId, state: "ready", servers: [] })
})

test("SDK failures and malformed/over-budget native maps are unavailable, not empty-ready or partial data", async (t) => {
  const f = await setup(t)
  const unavailable = { version: 1, projectId: f.projectId, state: "unavailable", servers: [] }
  for (const data of [undefined, null, [], "wrong", { server: null }, { server: { status: "future-status", error: secret } },
    { "bad\nname": { status: "connected" } }, { ["x".repeat(129)]: { status: "connected" } },
    { "bad\u202ename": { status: "connected" } },
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`server-${i}`, { status: "disabled" }])),
  ]) { f.state.data = data; assert.deepEqual(await f.read(), unavailable) }
  f.state.data = { server: { status: "connected" } }
  f.state.error = { message: secret }
  assert.deepEqual(await f.read(), unavailable)
  f.state.error = undefined; f.state.ok = false
  assert.deepEqual(await f.read(), unavailable)
  f.state.ok = true; f.state.beforeReturn = async () => { throw new Error(secret) }
  assert.deepEqual(await f.read(), unavailable)
})

test("foreign opaque project IDs and unauthorized paths cannot reach mcp.status", async (t) => {
  const f = await setup(t)
  for (const projectId of [crypto.randomUUID(), f.other, `${f.directory}/../other`]) {
    await assert.rejects(readProjectMcp(f.adapter, projectId, new AbortController().signal), { code: "context_expired" })
  }
  await assert.rejects(f.adapter.execute("project.open", { path: f.other }), { code: "access_denied" })
  assert.equal(f.state.calls.length, 0)
  await rename(f.directory, `${f.directory}-old`)
  await symlink(f.other, f.directory)
  await assert.rejects(f.read(), { code: "access_denied" })
  assert.equal(f.state.calls.length, 0)
})

test("canonical directory and inode are rechecked after a successful or failed SDK call", async (t) => {
  for (const mode of ["symlink", "replacement", "removed", "failed"]) {
    const f = await setup(t)
    f.state.data = { secretServer: { status: "connected" } }
    f.state.beforeReturn = async () => {
      await rename(f.directory, `${f.directory}-old`)
      if (mode === "symlink") await symlink(f.other, f.directory)
      if (mode === "replacement") await mkdir(f.directory)
      if (mode === "failed") throw new Error(secret)
    }
    await assert.rejects(f.read(), { code: "access_denied" })
    assert.equal(f.state.calls.length, 1)
  }
})

test("all configured canonical projects reuse the chat registry without widening access", async (t) => {
  const f = await setup(t)
  const calls = []
  const adapter = new OpenCodeChatAdapter({ mcp: { status: async ({ query }) => {
    calls.push(query.directory)
    return { data: { [path.basename(query.directory)]: { status: "connected" } }, response: { ok: true } }
  } } }, f.directory, [f.other])
  const { projects } = await adapter.execute("project.list", {})
  for (const project of projects) {
    const result = await readProjectMcp(adapter, project.id, new AbortController().signal)
    assert.equal(result.projectId, project.id)
    assert.equal(result.servers[0].name, project.name)
  }
  assert.deepEqual(calls, [f.directory, f.other])
})

test("lifecycle cancellation invalidates a pending SDK result and aborts its shared read signal", async (t) => {
  const f = await setup(t)
  let release, started
  const began = new Promise((resolve) => { started = resolve })
  f.state.beforeReturn = () => { started(); return new Promise((resolve) => { release = resolve }) }
  const controller = new AbortController()
  const pending = f.read(controller.signal)
  await began
  controller.abort()
  await assert.rejects(pending, { code: "context_expired" })
  assert.equal(f.state.calls[0].signal.aborted, true)
  release()
  await assert.rejects(f.read(controller.signal))
  assert.equal(f.state.calls.length, 1)
})
