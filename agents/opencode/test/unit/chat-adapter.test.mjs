import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"
import { OpenCodeAdapter } from "../../dist/opencode-adapter.js"

test("prompt maps only validated modes, preserves omission and rejects unauthorized sessions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-prompt-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const other = path.join(root, "other"); await mkdir(other)
  const session = { id: "ses_fixture", directory: root }
  const calls = []
  let status = 204, failure, membershipSignal
  const client = { session: {
    get: async ({ signal }) => {
      membershipSignal = signal
      return { data: session, response: { ok: true } }
    },
    promptAsync: async (options) => {
      calls.push(options)
      if (failure) throw failure
      return { response: new Response(null, { status }) }
    },
  } }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  const body = { version: 1, projectId: projects[0].id, sessionId: session.id, text: "Synthetic prompt" }
  for (const choice of [{}, { mode: "build" }, { mode: "plan" }]) {
    assert.deepEqual(await adapter.execute("chat.prompt", { ...body, ...choice }), { version: 1, accepted: true })
    const options = calls.at(-1)
    assert.deepEqual(options.body, { parts: [{ type: "text", text: body.text }],
      ...(choice.mode ? { agent: choice.mode } : {}) })
    assert.deepEqual(options.path, { id: session.id })
    assert.deepEqual(options.query, { directory: root })
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.signal, membershipSignal, "Membership and prompt share one deadline")
    assert.equal(options.signal.aborted, false)
  }
  for (const override of [{ mode: "general" }, { agent: "plan" }, { mode: null }, { mode: "plan", tools: {} }]) {
    await assert.rejects(adapter.execute("chat.prompt", { ...body, ...override }))
  }
  for (const mode of ["build", "plan"]) {
    session.parentID = "ses_parent"
    await assert.rejects(adapter.execute("chat.prompt", { ...body, mode }), { code: "access_denied" })
    delete session.parentID
    session.directory = other
    await assert.rejects(adapter.execute("chat.prompt", { ...body, mode }), { code: "access_denied" })
    session.directory = root
    await assert.rejects(adapter.execute("chat.prompt", { ...body, mode, projectId: crypto.randomUUID() }), { code: "context_expired" })
  }
  assert.equal(calls.length, 3)
  for (const nextStatus of [200, 400, 500]) {
    status = nextStatus
    await assert.rejects(adapter.execute("chat.prompt", { ...body, mode: "plan" }))
  }
  failure = new DOMException("Synthetic timeout", "TimeoutError")
  await assert.rejects(adapter.execute("chat.prompt", { ...body, mode: "build" }), { name: "TimeoutError" })
  assert.equal(calls.length, 7, "Failed mutations must not be retried")
})

test("delete validates descendants, refuses running work, and confirms removal", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-delete-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const other = path.join(root, "other"); await mkdir(other)
  const main = { id: "ses_main", directory: root, title: "Main", time: { updated: 1 } }
  const child = { ...main, id: "ses_child", parentID: main.id }
  let removed = false, deletes = 0, busy = false, falseSuccess = false
  const client = { session: {
    get: async ({ path: { id } }) => removed
      ? { response: { ok: false, status: 404 }, error: {} }
      : { response: { ok: true }, data: id === main.id ? main : child },
    children: async ({ path: { id } }) => ({ response: { ok: true }, data: id === main.id ? [child] : [] }),
    status: async () => ({ response: { ok: true }, data: busy ? { [child.id]: { type: "busy" } } : {} }),
    delete: async () => { deletes++; removed = !falseSuccess; return { response: { ok: true }, data: true } },
  } }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  const body = { projectId: projects[0].id, sessionId: main.id }
  assert.equal((await adapter.execute("chat.get", body)).chat.id, main.id)
  child.directory = other
  await assert.rejects(adapter.execute("chat.delete", body), { code: "access_denied" })
  child.directory = root; busy = true
  await assert.rejects(adapter.execute("chat.delete", body), { code: "chat_busy" })
  busy = false
  await assert.rejects(adapter.execute("chat.delete", { ...body, sessionId: child.id }), { code: "access_denied" })
  main.directory = other
  await assert.rejects(adapter.execute("chat.delete", body), { code: "access_denied" })
  main.directory = root
  assert.equal(deletes, 0)
  falseSuccess = true
  await assert.rejects(adapter.execute("chat.delete", body))
  falseSuccess = false
  assert.deepEqual(await adapter.execute("chat.delete", body), { version: 1, deleted: true })
  await assert.rejects(adapter.execute("chat.get", body), { code: "chat_not_found" })
})

test("both list APIs exclude child sessions and pagination reaches later main sessions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-main-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const main = { id: "ses_main", title: "Main", time: { created: 1, updated: 2 }, location: { directory: root } }
  const child = { ...main, id: "ses_child", title: "Sub-agent", parentID: main.id }
  const later = { ...main, id: "ses_later" }
  const client = { session: { list: async (options) => {
    if (!options) return { data: [child, main] }
    if (options.query.cursor === "next-page") {
      return { response: { ok: true }, data: { data: [child, later], cursor: { next: null } } }
    }
    return { response: { ok: true }, data: { data: [child], cursor: { next: "next-page" } } }
  } } }
  assert.deepEqual((await new OpenCodeAdapter(client).listSessions()).map((s) => s.id), [main.id])
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  const first = await adapter.execute("chat.list", { projectId: projects[0].id })
  assert.deepEqual(first.chats, [])
  assert.ok(first.cursor)
  const second = await adapter.execute("chat.list", { projectId: projects[0].id, cursor: first.cursor })
  assert.deepEqual(second.chats.map((s) => s.id), [later.id])
  assert.equal(second.cursor, null)
})

test("workspace handles reject traversal, replacement, and foreign session IDs before reading messages", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-policy-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const allowed = path.join(root, "allowed")
  const other = path.join(root, "other")
  await mkdir(allowed); await mkdir(other)
  let reads = 0
  const client = { session: {
    get: async () => ({ data: { id: "ses_foreign", directory: other }, response: { ok: true } }),
    messages: async () => { reads++; throw new Error("Not authorized") },
  } }
  const adapter = new OpenCodeChatAdapter(client, allowed)
  const projects = await adapter.execute("project.list", { version: 1 })
  const projectId = projects.projects[0].id
  for (const input of [other, path.join(allowed, "..", "other"), "relative", path.join(root, "missing")]) {
    await assert.rejects(adapter.execute("project.open", { path: input }), { code: "access_denied" })
  }
  await symlink(other, path.join(allowed, "escape"))
  await assert.rejects(adapter.execute("project.open", { path: path.join(allowed, "escape") }), { code: "access_denied" })
  await assert.rejects(adapter.execute("chat.snapshot", { projectId, sessionId: "ses_foreign" }), { code: "access_denied" })
  assert.equal(reads, 0)
  await assert.rejects(adapter.execute("chat.list", { projectId: crypto.randomUUID() }), { code: "context_expired" })
  await rm(allowed, { recursive: true })
  await symlink(other, allowed)
  await assert.rejects(adapter.execute("chat.list", { projectId }), { code: "access_denied" })
})

test("pagination retains the supplied SDK transport and rejects cross-project cursor reuse", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-cursor-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const second = path.join(root, "second"); await mkdir(second)
  const requests = []
  const client = { session: { list: async (options) => {
    requests.push(options)
    return { response: { ok: true }, data: { data: [], cursor: { next: "private-native-cursor" } } }
  } } }
  const adapter = new OpenCodeChatAdapter(client, root, [second])
  const { projects } = await adapter.execute("project.list", {})
  const page = await adapter.execute("chat.list", { projectId: projects[0].id })
  assert.notEqual(page.cursor, "private-native-cursor")
  assert.equal(requests[0].url, "/api/session")
  assert.equal(requests[0].query.directory, root)
  assert.equal(requests[0].query.limit, 50)
  await assert.rejects(adapter.execute("chat.list", { projectId: projects[1].id, cursor: page.cursor }), { code: "context_expired" })
  assert.equal(requests.length, 1)
})

test("chat.permission.reply is once/always/reject only, requires membership, and never targets a child session directly", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-permission-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = { id: "ses_fixture", directory: root }
  const calls = []
  let status = 204, failure
  const client = {
    session: { get: async () => ({ data: session, response: { ok: true } }) },
    postSessionIdPermissionsPermissionId: async (options) => {
      calls.push(options)
      if (failure) throw failure
      return { response: new Response(null, { status }) }
    },
  }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  const body = { version: 1, projectId: projects[0].id, sessionId: session.id, permissionId: "per_fixture" }
  for (const response of ["once", "always", "reject"]) {
    assert.deepEqual(await adapter.execute("chat.permission.reply", { ...body, response }), { version: 1, accepted: true })
    const options = calls.at(-1)
    assert.deepEqual(options.path, { id: session.id, permissionID: "per_fixture" })
    assert.deepEqual(options.body, { response })
    assert.deepEqual(options.query, { directory: root })
  }
  // Anything outside the enum is rejected before it could reach OpenCode, matching the protocol schema.
  await assert.rejects(adapter.execute("chat.permission.reply", { ...body, response: "forever" }))
  assert.equal(calls.length, 3, "the rejected enum value never reaches the SDK call")
  session.parentID = "ses_parent"
  await assert.rejects(adapter.execute("chat.permission.reply", { ...body, response: "once" }), { code: "access_denied" })
  delete session.parentID
  await assert.rejects(adapter.execute("chat.permission.reply", { ...body, response: "once", projectId: crypto.randomUUID() }),
    { code: "context_expired" })
  assert.equal(calls.length, 3)
  for (const nextStatus of [400, 404, 500]) {
    status = nextStatus
    await assert.rejects(adapter.execute("chat.permission.reply", { ...body, response: "reject" }))
  }
  failure = new DOMException("Synthetic timeout", "TimeoutError")
  await assert.rejects(adapter.execute("chat.permission.reply", { ...body, response: "once" }), { name: "TimeoutError" })
})

test("project ids are stable across restarts and distinct per directory", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-project-id-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const other = path.join(root, "other"); await mkdir(other)
  const client = {}
  const list = async () => (await new OpenCodeChatAdapter(client, root, [other]).execute("project.list", {})).projects

  // The regression this guards: ids were minted with crypto.randomUUID() per plugin load,
  // so restarting OpenCode expired every chat view the phone already had open. A second
  // adapter stands in for that restart.
  const first = await list()
  const second = await list()
  assert.deepEqual(second.map((p) => p.id), first.map((p) => p.id), "project ids changed across a restart")
  assert.notEqual(first[0].id, first[1].id, "two directories shared one id")
  for (const project of first) {
    assert.match(project.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  }
})
