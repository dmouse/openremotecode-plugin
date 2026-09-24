import assert from "node:assert/strict"
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { WorkspaceRegistry } from "../../dist/chat/workspace.js"
import { OpenCodeMcpReader } from "../../dist/opencode/mcp.js"
import { readProjectMcp } from "../../dist/project-mcp.js"

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-mcp-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, "project")
  await mkdir(directory)
  const registry = new WorkspaceRegistry(directory)
  const [{ id: projectId }] = await registry.list()
  const calls = []
  const state = { result: { location: { directory }, data: [] }, read: undefined }
  const client = { location: { get: async (input, options) => {
    calls.push({ input, options, location: true })
    return { directory: input.location.directory }
  } }, mcp: { list: async (input, options) => {
    calls.push({ input, options })
    return state.read ? state.read(input, options) : state.result
  } } }
  const reader = new OpenCodeMcpReader(client, registry)
  const signal = new AbortController().signal
  return { root, directory, projectId, calls, state, reader, signal }
}

test("reads project-scoped native MCP status and exposes only bounded names and states", async (t) => {
  const f = await setup(t)
  f.state.result.data = [
    { name: "context7", status: { status: "connected" }, integrationID: "private-id" },
    { name: "needs login", status: { status: "needs_auth", error: "private OAuth error" } },
    { name: "offline", status: { status: "failed", error: "private error" } },
    { name: "disabled", status: { status: "disabled" } },
    { name: "register", status: { status: "needs_client_registration" } },
  ]
  assert.deepEqual(await readProjectMcp(f.reader, f.projectId, f.signal), {
    version: 1, projectId: f.projectId, state: "ready", servers: [
      { name: "context7", status: "connected" },
      { name: "needs login", status: "needs_auth" },
      { name: "offline", status: "failed" },
      { name: "disabled", status: "disabled" },
      { name: "register", status: "needs_client_registration" },
    ],
  })
  assert.equal(f.calls[0].location, true)
  assert.deepEqual(f.calls[1].input, { location: { directory: f.directory } })
  assert.ok(f.calls[1].options.signal instanceof AbortSignal)
})

test("an unconfigured project never reaches OpenCode", async (t) => {
  const f = await setup(t)
  await assert.rejects(readProjectMcp(f.reader, crypto.randomUUID(), f.signal), { code: "context_expired" })
  assert.equal(f.calls.length, 0)
})

test("native failures, pending/unknown states and malformed lists are unavailable, never empty-ready", async (t) => {
  const f = await setup(t)
  for (const result of [
    { location: { directory: f.directory }, data: [{ name: "server", status: { status: "pending" } }] },
    { location: { directory: f.directory }, data: [{ name: "server", status: { status: "future" } }] },
    { location: { directory: f.directory }, data: [{ name: "ok", status: { status: "connected" } },
      { name: "bad\u202e", status: { status: "failed", error: "private" } }] },
    { location: { directory: f.directory }, data: Array.from({ length: 101 }, (_, i) => ({
      name: String(i), status: { status: "connected" },
    })) },
  ]) {
    f.state.result = result
    assert.deepEqual(await readProjectMcp(f.reader, f.projectId, f.signal), {
      version: 1, projectId: f.projectId, state: "unavailable", servers: [],
    })
  }
  f.state.read = () => { throw new Error("native error with secret") }
  assert.equal((await readProjectMcp(f.reader, f.projectId, f.signal)).state, "unavailable")
})

test("a native response for another directory is denied rather than presented as this project", async (t) => {
  const f = await setup(t)
  f.state.result.location.directory = path.join(f.root, "other")
  await assert.rejects(readProjectMcp(f.reader, f.projectId, f.signal), { code: "access_denied" })
})

test("replaced or removed project fails authorization before or after the native call", async (t) => {
  const f = await setup(t)
  await rename(f.directory, `${f.directory}-old`)
  await mkdir(f.directory)
  await assert.rejects(readProjectMcp(f.reader, f.projectId, f.signal), { code: "access_denied" })
  assert.equal(f.calls.length, 0)

  const second = await setup(t)
  second.state.read = async () => {
    await rename(second.directory, `${second.directory}-old`)
    await mkdir(second.directory)
    return second.state.result
  }
  await assert.rejects(readProjectMcp(second.reader, second.projectId, second.signal), { code: "access_denied" })
  assert.equal(second.calls.length, 2)
})

test("a native failure cannot hide a concurrent project removal", async (t) => {
  const f = await setup(t)
  f.state.read = async () => {
    await rm(f.directory, { recursive: true })
    throw new Error("SDK failed")
  }
  await assert.rejects(readProjectMcp(f.reader, f.projectId, f.signal), { code: "access_denied" })
})
