import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { ChatAccessError, ChatUnsupportedError } from "../../dist/chat-adapter.js"
import { OpenCodeChatAdapter } from "../../dist/opencode/chat-adapter.js"
import { OpenCodeSessionReader } from "../../dist/opencode/sessions.js"
import { WorkspaceRegistry } from "../../dist/chat/workspace.js"
import { announceDirectory, liveDirectories, liveSessionIds } from "../../dist/directory-presence.js"
import { FileFolderApprovalStore } from "../../dist/folder-approvals.js"
import { OpenCodeMcpReader } from "../../dist/opencode/mcp.js"

const NOW = 1_788_115_200_000

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-chat-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const other = path.join(root, "other"); await mkdir(other)
  const sessions = new Map()
  const calls = []
  const state = { active: {}, permissions: [], messages: new Map(), models: [], providers: new Map(),
    forms: [], formOutcomes: [], forkResult: undefined, forkError: undefined, removalKeeps: false, localSessions: [],
    // Overridden per test; default yields nothing so a subscription just idles until aborted.
    events: (signal) => ({ [Symbol.asyncIterator]: () => ({
      next: () => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))) }) }) }
  const add = (id, extra = {}) => sessions.set(id, { id, title: `Chat ${id}`, projectID: "p",
    time: { created: NOW, updated: NOW + 1 }, location: { directory: root }, ...extra })
  const client = {
    session: {
      list: async (input, options) => {
        calls.push(["session.list", input, options])
        const data = [...sessions.values()].filter((s) =>
          (input.directory === undefined || s.location.directory === input.directory) &&
          (input.parentID === null ? !s.parentID : s.parentID === input.parentID))
        // Real OpenCode always returns a next cursor, even on the last page.
        const start = input.cursor === "native-next" ? 50 : Number(input.cursor?.replace("native:", "") ?? 0)
        const next = start === 0 && input.limit === 50 ? "native-next" : `native:${start + input.limit}`
        return { data: data.slice(start, start + input.limit), cursor: { next, previous: "native-prev" } }
      },
      create: async (input, options) => {
        calls.push(["session.create", input, options])
        add("ses_new", { location: { directory: input.location.directory } })
        return sessions.get("ses_new")
      },
      get: async (input, options) => {
        calls.push(["session.get", input, options])
        const found = sessions.get(input.sessionID)
        // Real OpenCode rejects with a plain tagged object, not an Error.
        if (!found) throw { _tag: "SessionNotFoundError", sessionID: input.sessionID, message: "Session not found" }
        return found
      },
      fork: async (input, options) => {
        calls.push(["session.fork", input, options])
        if (state.forkError) throw state.forkError
        if (state.forkResult) return state.forkResult
        add("ses_fork", { fork: { sessionID: input.sessionID } })
        return sessions.get("ses_fork")
      },
      remove: async (input, options) => {
        calls.push(["session.remove", input, options])
        if (state.removalKeeps) return
        const removed = new Set([input.sessionID])
        for (let count = 0; count < sessions.size; count++) {
          for (const session of sessions.values()) if (removed.has(session.parentID)) removed.add(session.id)
        }
        for (const id of removed) sessions.delete(id)
      },
      prompt: async (input, options) => { calls.push(["session.prompt", input, options]); return {} },
      switchAgent: async (input, options) => {
        calls.push(["session.switchAgent", input, options])
        // A real server rejects an agent it does not know with a plain tagged object.
        if (state.switchFails) throw { _tag: "InvalidRequestError", message: "Unknown agent" }
      },
      switchModel: async (input, options) => { calls.push(["session.switchModel", input, options]) },
      interrupt: async (input, options) => { calls.push(["session.interrupt", input, options]); return {} },
      active: async (options) => { calls.push(["session.active", {}, options]); return state.active },
      form: {
        list: async (input, options) => { calls.push(["form.list", input, options])
          return state.forms.filter((f) => f.sessionID === input.sessionID) },
        reply: async (input, options) => { calls.push(["form.reply", input, options])
          const form = state.forms.find((f) => f.id === input.formID)
          if (!form) throw { _tag: "FormNotFoundError", formID: input.formID }
          state.forms = state.forms.filter((f) => f.id !== input.formID)
          state.formOutcomes.push({ id: input.formID, answer: input.answer }) },
        cancel: async (input, options) => { calls.push(["form.cancel", input, options])
          const form = state.forms.find((f) => f.id === input.formID)
          if (!form) throw { _tag: "FormNotFoundError", formID: input.formID }
          state.forms = state.forms.filter((f) => f.id !== input.formID)
          state.formOutcomes.push({ id: input.formID, cancelled: true }) },
      },
    },
    event: { subscribe: (options) => state.events(options.signal) },
    location: { get: async (input, options) => { calls.push(["location.get", input, options]); return {} } },
    model: { list: async (input, options) => { calls.push(["model.list", input, options]); return { data: state.models } } },
    provider: { get: async (input, options) => {
      calls.push(["provider.get", input, options])
      if (!state.providers.has(input.providerID)) throw { _tag: "ProviderNotFoundError", providerID: input.providerID }
      return { id: input.providerID, name: state.providers.get(input.providerID) }
    } },
    message: { list: async (input, options) => {
      calls.push(["message.list", input, options])
      const all = state.messages.get(input.sessionID) ?? []
      // Newest first, like real OpenCode; a cursor continues from where the previous page stopped.
      const ordered = [...all].reverse()
      const start = input.cursor ? Number(input.cursor.replace("m:", "")) : 0
      const data = ordered.slice(start, start + input.limit)
      return { data, cursor: { next: `m:${start + input.limit}`, previous: null } }
    } },
    permission: { list: async (input, options) => { calls.push(["permission.list", input, options]); return state.permissions },
      reply: async (input, options) => { calls.push(["permission.reply", input, options]) } },
  }
  const adapter = new OpenCodeChatAdapter(client, root, [], undefined,
    (workspace) => workspace.path === root ? state.localSessions : [])
  const { projects } = await adapter.execute("project.list", {})
  return { root, other, sessions, add, calls, client, adapter, projectId: projects[0].id, state }
}

test("advertises exactly the operations it implements", async (t) => {
  const { adapter, root } = await fixture(t)
  assert.equal(new OpenCodeChatAdapter({}, root).capabilities.includes("chat.view"), false,
    "a partial host context must not prevent relay startup")
  assert.deepEqual([...adapter.capabilities].sort(), ["chat.abort", "chat.activities", "chat.code", "chat.create", "chat.delete",
    "chat.fork", "chat.get", "chat.images", "chat.list", "chat.models", "chat.permission.reply", "chat.permissions", "chat.prompt",
    "chat.prompt.mode", "chat.prompt.model", "chat.question.reply", "chat.questions", "chat.shell", "chat.snapshot", "chat.subtask.snapshot",
    "chat.tools", "project.list", "project.open"])
})

test("activity summaries use authoritative active state and native completion/view clocks", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_done", { outcome: "succeeded", time: { updated: NOW, idle: NOW, viewed: NOW - 10 } })
  add("ses_busy", { outcome: "succeeded", time: { updated: NOW, idle: NOW - 100, viewed: NOW - 100 } })
  add("ses_failed", { outcome: "failed", time: { updated: NOW, idle: NOW } })
  state.active.ses_busy = { type: "running" }
  const { chats } = await adapter.execute("chat.list", { version: 1, projectId })
  assert.deepEqual(chats.find((c) => c.id === "ses_done").activity,
    { status: "idle", idleAt: NOW, viewedAt: NOW - 10, outcome: "succeeded" })
  assert.equal(chats.find((c) => c.id === "ses_busy").activity.status, "busy")
  assert.equal(chats.find((c) => c.id === "ses_failed").activity.outcome, "failed")
})

test("view acknowledges the observed completion, refuses future clocks and foreign/subtask sessions", async (t) => {
  const { adapter, projectId, add, client, calls, other } = await fixture(t)
  assert.equal(adapter.capabilities.includes("chat.view"), false)
  client.session.view = async (input) => { calls.push(["session.view", input]) }
  assert.equal(adapter.capabilities.includes("chat.view"), true)
  add("ses_done", { time: { updated: NOW, idle: NOW } })
  const body = { version: 1, projectId, sessionId: "ses_done", idleAt: NOW - 100 }
  assert.deepEqual(await adapter.execute("chat.view", body), {version: 1, accepted: true})
  assert.deepEqual(calls.find(([name]) => name === "session.view")[1], {sessionID: "ses_done", idle: NOW - 100})
  await assert.rejects(adapter.execute("chat.view", {...body, idleAt: NOW + 1}), {code: "context_expired"})
  add("ses_foreign", {location: {directory: other}})
  add("ses_child", {parentID: "ses_done"})
  for (const sessionId of ["ses_foreign", "ses_child"]) {
    await assert.rejects(adapter.execute("chat.view", {...body, sessionId}), {code: "access_denied"})
  }
  assert.equal(calls.filter(([name]) => name === "session.view").length, 1)
})

test("list updates never expose foreign roots or children, nor read message history", async (t) => {
  const { adapter, projectId, add, state, other, calls } = await fixture(t)
  add("ses_own", {outcome: "succeeded", time: {updated: NOW, idle: NOW}})
  add("ses_foreign", {location: {directory: other}})
  add("ses_child", {parentID: "ses_own"})
  state.active.ses_own = {type: "retrying"}
  const updates = await adapter.listReader.read([projectId], ["ses_own", "ses_foreign", "ses_child"], AbortSignal.timeout(1000))
  assert.deepEqual(updates.map((u) => [u.projectId, u.chat.id, u.chat.activity.status]), [[projectId, "ses_own", "retry"]])
  assert.equal(calls.some(([name]) => name === "message.list"), false)
  await assert.rejects(adapter.listReader.read([crypto.randomUUID()], ["ses_own"], AbortSignal.timeout(1000)), {code: "context_expired"})
})

test("only persistent approvals grant projects; disabling denies saved handles, moved chats, MCP and legacy reads", async (t) => {
  const { client, root, other, add, sessions, calls } = await fixture(t)
  const store = new FileFolderApprovalStore(path.join(root, "private", "approved-folders"))
  const registry = new WorkspaceRegistry(undefined, [], () => store.list())
  const adapter = new OpenCodeChatAdapter(client, root, [other], registry)
  const reader = new OpenCodeSessionReader(client, root, registry)
  assert.deepEqual(await adapter.execute("project.list", {}), { version: 1, projects: [], pathEntry: false })
  await assert.rejects(adapter.execute("project.open", { path: root }), { code: "access_denied" })
  await assert.rejects(reader.listSessions(), { code: "access_denied" })
  assert.deepEqual(calls, [])
  const approved = await store.inspect(root)
  await store.setEnabled(approved, true)
  const { projects: [project] } = await adapter.execute("project.list", {})
  add("ses_moving"); add("ses_other", { location: { directory: other } })
  assert.equal((await reader.listSessions()).length, 1)
  const body = { version: 1, projectId: project.id, sessionId: "ses_moving" }
  await adapter.execute("chat.get", body)
  sessions.get("ses_moving").location.directory = other
  assert.equal((await adapter.execute("chat.get", body)).chat.id, "ses_moving")
  await store.setEnabled(approved, false)
  const before = calls.length
  for (const operation of ["chat.list", "chat.get", "chat.snapshot", "chat.prompt", "chat.abort", "chat.models",
    "chat.permission.reply", "chat.question.reply", "chat.fork", "chat.delete"]) {
    await assert.rejects(adapter.execute(operation, body), { code: "context_expired" })
  }
  await assert.rejects(adapter.readChat(body, new AbortController().signal), { code: "context_expired" })
  await assert.rejects(new OpenCodeMcpReader(client, registry).readProjectMcp(project.id, new AbortController().signal),
    { code: "context_expired" })
  await assert.rejects(reader.listSessions(), { code: "access_denied" })
  assert.equal(calls.length, before, "no SDK call after local disable, even for known moved chats")
  assert.deepEqual((await adapter.execute("project.list", {})).projects, [])
})

test("revoking approval during an SDK read discards the in-flight result", async (t) => {
  const { client, root, add } = await fixture(t)
  const store = new FileFolderApprovalStore(path.join(root, "private", "approved-folders"))
  const approved = await store.inspect(root)
  await store.setEnabled(approved, true)
  const registry = new WorkspaceRegistry(undefined, [], () => store.list())
  const adapter = new OpenCodeChatAdapter(client, root, [], registry)
  const { projects: [project] } = await adapter.execute("project.list", {})
  add("ses_1")
  const originalList = client.session.list
  client.session.list = async (...args) => {
    const data = await originalList(...args)
    await store.setEnabled(approved, false)
    return data
  }
  await assert.rejects(adapter.execute("chat.list", { projectId: project.id }), { code: "context_expired" })
  await store.setEnabled(approved, true)
  client.session.list = originalList
  const originalMessages = client.message.list
  client.message.list = async (...args) => {
    const data = await originalMessages(...args)
    await store.setEnabled(approved, false)
    return data
  }
  await assert.rejects(adapter.readChat({ projectId: project.id, sessionId: "ses_1" }, new AbortController().signal),
    { code: "context_expired" })
})

test("disabling a folder ends an idle event subscription without an SDK poll or a model event", async (t) => {
  const { client, root, add, calls } = await fixture(t)
  add("ses_1")
  const store = new FileFolderApprovalStore(path.join(root, "private", "approved-folders"))
  const approved = await store.inspect(root)
  await store.setEnabled(approved, true)
  const registry = new WorkspaceRegistry(undefined, [], () => store.list())
  const adapter = new OpenCodeChatAdapter(client, root, [], registry)
  const { projects: [project] } = await adapter.execute("project.list", {})
  const controller = new AbortController()
  let connected
  const ready = new Promise((resolve) => { connected = resolve })
  const original = client.event.subscribe
  client.event.subscribe = (options) => { connected(); return original(options) }
  const watching = adapter.watchChat({ projectId: project.id, sessionId: "ses_1" }, controller.signal,
    () => assert.fail("no event was sent"))
  const ended = assert.rejects(watching, /stream ended/)
  const timer = setTimeout(() => controller.abort(), 3000)
  t.after(() => { clearTimeout(timer); controller.abort() })
  await ready
  const count = calls.length
  await store.setEnabled(approved, false)
  await ended
  assert.equal(controller.signal.aborted, false, "authorization, not the test timeout, must end the watcher")
  assert.equal(calls.length, count, "local monitoring does not poll OpenCode")
})

test("legacy session reads never trust a native directory filter that includes an unapproved folder", async (t) => {
  const { client, root, other, add, sessions } = await fixture(t)
  const registry = new WorkspaceRegistry(root)
  add("ses_foreign", { location: { directory: other } })
  client.session.list = async () => ({ data: [...sessions.values()], cursor: {} })
  const reader = new OpenCodeSessionReader(client, root, registry)
  await assert.rejects(reader.listSessions(), { code: "access_denied" })
})

test("operations outside the implemented set fail as unsupported, not as generic errors", async (t) => {
  const { adapter, projectId, add } = await fixture(t)
  add("ses_1")
  for (const [operation, body] of [
    ["chat.rename", { version: 1, projectId, sessionId: "ses_1", title: "x" }],
  ]) {
    await assert.rejects(adapter.execute(operation, { ...body }), ChatUnsupportedError)
  }
  await assert.rejects(adapter.execute("chat.unknown", {}), ChatUnsupportedError)
})

test("chat.list returns root sessions of the workspace and ends on a short page", async (t) => {
  const { adapter, projectId, add, calls, other } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" }); add("ses_x", { location: { directory: other } })
  const only = await adapter.execute("chat.list", { version: 1, projectId })
  assert.deepEqual(only.chats.map((c) => c.id), ["ses_1"])
  assert.equal(only.chats[0].updatedAt, NOW + 1)
  assert.equal(only.cursor, null, "OpenCode's always-present next cursor must not become an endless page")
  const [, input, options] = calls.find(([name]) => name === "session.list")
  assert.equal(input.parentID, null)
  assert.equal(input.limit, 50)
  assert.ok(options.signal instanceof AbortSignal)
})

test("a full page yields an opaque, project-bound cursor that resolves to the native one", async (t) => {
  const { adapter, projectId, add, calls } = await fixture(t)
  for (let i = 0; i < 50; i++) add(`ses_${i}`)
  const first = await adapter.execute("chat.list", { version: 1, projectId })
  assert.equal(first.chats.length, 50)
  assert.match(first.cursor, /^[0-9a-f-]{36}$/)
  assert.notEqual(first.cursor, "native-next", "native cursors never cross the wire")
  await adapter.execute("chat.list", { version: 1, projectId, cursor: first.cursor })
  assert.equal(calls.filter(([name]) => name === "session.list").at(-1)[1].cursor, "native-next")
  await assert.rejects(adapter.execute("chat.list", { version: 1, projectId, cursor: crypto.randomUUID() }),
    { code: "context_expired" })
})

test("a session outside the workspace is denied even if the server filter is ignored", async (t) => {
  const { adapter, projectId, other, add, sessions } = await fixture(t)
  add("ses_1")
  sessions.get("ses_1").location.directory = other
  const leaky = new OpenCodeChatAdapter({ session: { list: async () => ({ data: [sessions.get("ses_1")], cursor: {} }),
    get: async () => sessions.get("ses_1") }, permission: {} }, path.dirname(other))
  const { projects } = await leaky.execute("project.list", {})
  await assert.rejects(leaky.execute("chat.list", { version: 1, projectId: projects[0].id }), { code: "access_denied" })
  await assert.rejects(adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_1" }), { code: "access_denied" })
})

test("an open chat keeps its original project handle after repeated authoritative moves", async (t) => {
  const { adapter, projectId, root, other, sessions, add, state, calls } = await fixture(t)
  add("ses_mobile"); add("ses_foreign", { location: { directory: other } })
  state.messages.set("ses_mobile", [user(0), assistant(0, [{ type: "text", text: "answer" }])])
  const body = { version: 1, projectId, sessionId: "ses_mobile" }
  await adapter.execute("chat.get", body)
  for (const directory of [other, root, other]) {
    sessions.get("ses_mobile").location.directory = directory
    // No event is needed to recover an open chat after a missed notification or relay reconnect.
    const snapshot = await adapter.readChat({ ...body, subscriptionId: crypto.randomUUID() }, new AbortController().signal)
    assert.equal(snapshot.chat.id, "ses_mobile")
    assert.equal(snapshot.messages.length, 2)
    assert.deepEqual(await adapter.execute("chat.prompt", { ...body, text: "continue" }), { version: 1, accepted: true })
    assert.deepEqual(await adapter.execute("chat.abort", body), { version: 1, accepted: true })
    await adapter.execute("chat.permission.reply", { ...body, permissionId: "per_move", response: "once" })
  }
  state.models = MODELS
  await adapter.execute("chat.prompt", { ...body, text: "continue", model: { providerID: "acme", modelID: "m1" } })
  assert.equal(calls.filter(([name]) => name === "model.list").at(-1)[1].location.directory, other)
  await assert.rejects(adapter.execute("chat.get", { ...body, sessionId: "ses_foreign" }), { code: "access_denied" })
  await assert.rejects(adapter.execute("project.open", { version: 1, path: other }), { code: "access_denied" })
  assert.deepEqual((await adapter.execute("project.list", {})).projects.map((p) => p.path), [root],
    "continuity never grants the destination directory")
})

test("moved chats remain in the original list while mobile is disconnected", async (t) => {
  const { adapter, projectId, other, add, sessions } = await fixture(t)
  add("ses_moved"); add("ses_stays")
  await adapter.execute("chat.list", { version: 1, projectId })
  sessions.get("ses_moved").location.directory = other
  adapter.observeEvent({ type: "session.moved", data: { sessionID: "ses_moved", location: { directory: "/untrusted" } } })
  const listed = await adapter.execute("chat.list", { version: 1, projectId })
  assert.deepEqual(listed.chats.map((c) => c.id), ["ses_moved", "ses_stays"])
  assert.equal(listed.cursor, null)
  sessions.delete("ses_moved")
  assert.deepEqual((await adapter.execute("chat.list", { version: 1, projectId })).chats.map((c) => c.id), ["ses_stays"])
})

test("reconnect reconciliation and pagination preserve more than fifty moved chats", async (t) => {
  const { adapter, projectId, add, sessions, other } = await fixture(t)
  for (let i = 0; i < 53; i++) add(`ses_${i}`)
  const first = await adapter.execute("chat.list", { version: 1, projectId })
  await adapter.execute("chat.list", { version: 1, projectId, cursor: first.cursor })
  for (const value of sessions.values()) value.location.directory = other
  adapter.observeEvent({ type: "server.connected" }) // Move events were missed while the local transport was down.
  const found = []
  let cursor
  do {
    const page = await adapter.execute("chat.list", { version: 1, projectId, ...(cursor ? { cursor } : {}) })
    assert.ok(page.chats.length <= 50)
    found.push(...page.chats.map((c) => c.id))
    cursor = page.cursor
    assert.ok(found.length <= 53, "pagination must terminate without duplicates")
  } while (cursor)
  assert.equal(new Set(found).size, 53)
})

test("moved chats stay on the first page without skipping native chats or changing their cursor scope", async (t) => {
  const { adapter, projectId, add, sessions, other, calls } = await fixture(t)
  add("ses_moved")
  await adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_moved" })
  sessions.get("ses_moved").location.directory = other
  adapter.observeEvent({ type: "session.moved", data: { sessionID: "ses_moved" } })
  for (let i = 0; i < 101; i++) add(`ses_native_${i}`)
  const first = await adapter.execute("chat.list", { version: 1, projectId })
  assert.equal(first.chats[0].id, "ses_moved")
  assert.equal(first.chats.length, 50)
  assert.equal(calls.find(([name]) => name === "session.list")[1].limit, 49)
  adapter.observeEvent({ type: "server.connected" })
  const ids = first.chats.map((c) => c.id)
  let cursor = first.cursor
  while (cursor) {
    const next = await adapter.execute("chat.list", { version: 1, projectId, cursor })
    ids.push(...next.chats.map((c) => c.id))
    cursor = next.cursor
    assert.ok(ids.length <= 102)
  }
  assert.equal(new Set(ids).size, 102)
  assert.equal(ids.length, 102)
  const reconnected = await adapter.execute("chat.list", { version: 1, projectId })
  assert.ok(reconnected.chats.length > 0, "dirty unchanged sessions must not hide the native first page")
})

test("only locally open TUI sessions can recover a move predating adapter startup", async (t) => {
  const { adapter, projectId, state, other, add } = await fixture(t)
  add("ses_local", { location: { directory: other } })
  add("ses_hidden", { location: { directory: other } })
  state.localSessions = ["ses_local"]
  adapter.observeEvent({ type: "session.moved", data: { sessionID: "ses_hidden" } })
  const listed = await adapter.execute("chat.list", { version: 1, projectId })
  assert.deepEqual(listed.chats.map((c) => c.id), ["ses_local"])
  await assert.rejects(adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_hidden" }), { code: "access_denied" })
  state.localSessions = []
  assert.equal((await adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_local" })).chat.id, "ses_local")
})

test("the connection holder recovers a standby TUI's moved tab without authorizing its destination", async (t) => {
  const { root, other, add, client } = await fixture(t)
  const destination = path.join(root, "destination"); await mkdir(destination)
  add("ses_standby", { location: { directory: destination } })
  add("ses_foreign", { location: { directory: destination } })
  const presencePath = path.join(root, "presence")
  const presence = announceDirectory({ presencePath, directory: other, sessionIds: () => ["ses_standby"] })
  t.after(() => presence.stop())
  // Wait for the independent TUI's first heartbeat, not a global session enumeration.
  for (let i = 0; !(await liveSessionIds(presencePath, other)).length; i++) {
    assert.ok(i < 100)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const registry = new WorkspaceRegistry(root, [], () => liveDirectories(presencePath))
  const holder = new OpenCodeChatAdapter(client, root, [], registry, (workspace) => liveSessionIds(presencePath, workspace.path))
  const projectId = (await holder.execute("project.list", {})).projects.find((p) => p.path === other).id
  const body = { version: 1, projectId }
  assert.deepEqual((await holder.execute("chat.list", body)).chats.map((c) => c.id), ["ses_standby"])
  await assert.rejects(holder.execute("chat.get", { ...body, sessionId: "ses_foreign" }), { code: "access_denied" })
  await assert.rejects(holder.execute("project.open", { version: 1, path: destination }), { code: "access_denied" })
  await presence.stop()
  await assert.rejects(holder.execute("chat.get", { ...body, sessionId: "ses_standby" }), { code: "context_expired" },
    "continuity cannot bypass expiry of the original workspace authorization")
})

test("a moved chat keeps its history cursor and uses the current directory for a fork", async (t) => {
  const { adapter, projectId, state, other, add, sessions } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", Array.from({ length: 12 }, (_, i) => user(i)))
  const body = { version: 1, projectId, sessionId: "ses_1" }
  const first = await adapter.execute("chat.snapshot", body)
  sessions.get("ses_1").location.directory = other
  const older = await adapter.execute("chat.snapshot", { ...body, cursor: first.cursor })
  assert.equal(older.messages.length, 2)
  assert.equal(older.cursor, null)
  add("ses_fork", { fork: { sessionID: "ses_1" }, location: { directory: other } })
  state.forkResult = sessions.get("ses_fork")
  assert.equal((await adapter.execute("chat.fork", body)).chat.id, "ses_fork")
  assert.deepEqual(await adapter.execute("chat.delete", { ...body, sessionId: "ses_fork" }), { version: 1, deleted: true })
})

test("a moved chat refuses replaced destinations and symlink retargeting", async (t) => {
  const { adapter, projectId, root, other, add, sessions } = await fixture(t)
  add("ses_1")
  const body = { version: 1, projectId, sessionId: "ses_1" }
  await adapter.execute("chat.get", body)
  const link = path.join(root, "link")
  await symlink(other, link)
  sessions.get("ses_1").location.directory = link
  await adapter.execute("chat.get", body)
  await rm(link)
  await symlink(root, link)
  await assert.rejects(adapter.execute("chat.get", body), { code: "access_denied" })
  sessions.get("ses_1").location.directory = other
  await rename(other, `${other}-previous`)
  await mkdir(other)
  await assert.rejects(adapter.execute("chat.get", body), { code: "access_denied" })
})

test("a moved root can read and delete its verified children, never a foreign descendant", async (t) => {
  const { adapter, projectId, other, add, sessions, calls } = await fixture(t)
  add("ses_parent")
  const body = { version: 1, projectId, sessionId: "ses_parent" }
  await adapter.execute("chat.get", body)
  sessions.get("ses_parent").location.directory = other
  add("ses_child", { parentID: "ses_parent", location: { directory: other } })
  const child = { version: 1, projectId, parentSessionId: "ses_parent", sessionId: "ses_child" }
  assert.equal((await adapter.execute("chat.subtask.snapshot", child)).chat.parentId, "ses_parent")
  await assert.rejects(adapter.execute("chat.get", { ...body, sessionId: "ses_child" }), { code: "access_denied" })
  add("ses_foreign_child", { parentID: "ses_child" })
  await assert.rejects(adapter.execute("chat.delete", body), { code: "access_denied" })
  assert.equal(calls.some(([name]) => name === "session.remove"), false)
  sessions.delete("ses_foreign_child")
  assert.deepEqual(await adapter.execute("chat.delete", body), { version: 1, deleted: true })
  assert.equal(sessions.has("ses_child"), false)
})

test("chat.create verifies ownership and get maps a missing session to chat_not_found", async (t) => {
  const { adapter, projectId, root, calls } = await fixture(t)
  const created = await adapter.execute("chat.create", { version: 1, projectId })
  assert.equal(created.chat.id, "ses_new")
  assert.deepEqual(calls.find(([name]) => name === "session.create")[1], { location: { directory: root } })
  assert.deepEqual(await adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_new" }),
    { ...created, chat: { ...created.chat, activity: { status: "idle" } } })
  await assert.rejects(adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_missing" }), { code: "chat_not_found" })
})

test("creation that cannot be confirmed is uncertain and cannot grant a foreign chat", async (t) => {
  const { adapter, projectId, client, other, add } = await fixture(t)
  add("ses_foreign", { location: { directory: other } })
  client.session.create = async () => ({ id: "ses_foreign" })
  await assert.rejects(adapter.execute("chat.create", { version: 1, projectId }), /Created chat could not be confirmed/)
  await assert.rejects(adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_foreign" }), { code: "access_denied" })
})

test("fork and delete are confined to an idle root session in the authorized project", async (t) => {
  const { adapter, projectId, other, add, calls, sessions, state } = await fixture(t)
  add("ses_1")
  const fork = await adapter.execute("chat.fork", { version: 1, projectId, sessionId: "ses_1" })
  assert.equal(fork.chat.id, "ses_fork")
  assert.deepEqual(calls.find(([name]) => name === "session.fork")[1], { sessionID: "ses_1" })
  assert.ok(calls.find(([name]) => name === "session.fork")[2].signal instanceof AbortSignal)
  assert.ok(calls.some(([name, input]) => name === "session.get" && input.sessionID === "ses_fork"),
    "the new fork must exist independently of the SDK's mutation response")
  assert.deepEqual(await adapter.execute("chat.delete", { version: 1, projectId, sessionId: "ses_1" }),
    { version: 1, deleted: true })
  assert.equal(sessions.has("ses_1"), false)
  assert.deepEqual(calls.find(([name]) => name === "session.remove")[1], { sessionID: "ses_1" })

  add("ses_child", { parentID: "ses_fork" })
  add("ses_foreign", { location: { directory: other } })
  state.active = { ses_fork: { type: "running" } }
  for (const operation of ["chat.fork", "chat.delete"]) {
    await assert.rejects(adapter.execute(operation, { version: 1, projectId, sessionId: "ses_fork" }),
      { code: "chat_busy" })
    await assert.rejects(adapter.execute(operation, { version: 1, projectId, sessionId: "ses_child" }),
      { code: "access_denied" })
    await assert.rejects(adapter.execute(operation, { version: 1, projectId, sessionId: "ses_foreign" }),
      { code: "access_denied" })
    await assert.rejects(adapter.execute(operation, { version: 1, projectId: crypto.randomUUID(), sessionId: "ses_fork" }),
      { code: "context_expired" })
  }
  assert.equal(calls.filter(([name]) => name === "session.fork" || name === "session.remove").length, 2,
    "refused requests never mutate native sessions")
})

test("a fork response for another project, a subtask, or a different source never reaches the client", async (t) => {
  const { adapter, projectId, add, other, sessions, state } = await fixture(t)
  add("ses_1")
  for (const extra of [
    { location: { directory: other } },
    { parentID: "ses_1" },
    { fork: { sessionID: "ses_other" } },
  ]) {
    state.forkResult = { ...sessions.get("ses_1"), id: "ses_new", fork: { sessionID: "ses_1" }, ...extra }
    await assert.rejects(adapter.execute("chat.fork", { version: 1, projectId, sessionId: "ses_1" }),
      /Fork could not be confirmed/)
  }
  state.forkResult = { ...sessions.get("ses_1"), id: "ses_missing_fork", fork: { sessionID: "ses_1" } }
  await assert.rejects(adapter.execute("chat.fork", { version: 1, projectId, sessionId: "ses_1" }),
    /Fork could not be confirmed/)
  // A plausible mutation response must not grant continuity before the independent get
  // confirms that the new session really belongs to the source's current directory.
  state.forkResult = { ...sessions.get("ses_1"), id: "ses_impostor", fork: { sessionID: "ses_1" } }
  add("ses_impostor", { location: { directory: other }, fork: { sessionID: "ses_1" } })
  await assert.rejects(adapter.execute("chat.fork", { version: 1, projectId, sessionId: "ses_1" }),
    /Fork could not be confirmed/)
  await assert.rejects(adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_impostor" }), { code: "access_denied" })
  state.forkError = { _tag: "InvalidRequestError", kind: "empty_session", message: "contains native details" }
  await assert.rejects(adapter.execute("chat.fork", { version: 1, projectId, sessionId: "ses_1" }),
    { code: "context_expired" })
})

test("deletion verifies the complete child tree and refuses active or foreign descendants", async (t) => {
  const { adapter, projectId, other, add, calls, sessions, state } = await fixture(t)
  add("ses_parent")
  add("ses_child", { parentID: "ses_parent" })
  add("ses_grandchild", { parentID: "ses_child" })
  state.active = { ses_child: { type: "running" } }
  const remove = () => adapter.execute("chat.delete", { version: 1, projectId, sessionId: "ses_parent" })
  await assert.rejects(remove(), { code: "chat_busy" })
  assert.equal(calls.some(([name]) => name === "session.remove"), false)

  state.active = {}
  sessions.get("ses_grandchild").location.directory = other
  await assert.rejects(remove(), { code: "access_denied" })
  assert.equal(calls.some(([name]) => name === "session.remove"), false)

  sessions.get("ses_grandchild").location.directory = path.dirname(other)
  state.removalKeeps = true
  await assert.rejects(remove(), /Deletion could not be confirmed/)
  state.removalKeeps = false
  assert.deepEqual(await remove(), { version: 1, deleted: true })
  assert.equal([...sessions.keys()].some((id) => ["ses_parent", "ses_child", "ses_grandchild"].includes(id)), false)
  assert.ok(calls.some(([name, input]) => name === "session.list" && input.parentID === "ses_child"),
    "descendants are discovered without filtering out another directory")
})

test("a prompt without a mode or model sends text only", async (t) => {
  const { adapter, projectId, add, calls } = await fixture(t)
  add("ses_1")
  const body = { version: 1, projectId, sessionId: "ses_1", text: "Synthetic prompt" }
  assert.deepEqual(await adapter.execute("chat.prompt", body), { version: 1, accepted: true })
  const [, input, options] = calls.find(([name]) => name === "session.prompt")
  assert.deepEqual(input, { sessionID: "ses_1", text: "Synthetic prompt" })
  assert.ok(options.signal instanceof AbortSignal)
  assert.equal(calls.some(([name]) => name === "session.switchAgent" || name === "session.switchModel"), false,
    "nothing named, nothing switched")
})

const MODELS = [{ id: "m1", modelID: "m1", providerID: "acme", name: "Acme One", variants: [{ id: "low" }, { id: "high" }] },
  { id: "m2", modelID: "m2", providerID: "acme", name: "Acme Two" }]

test("a prompt's model and effort switch the session model before the prompt is sent", async (t) => {
  const { adapter, projectId, add, calls, state } = await fixture(t)
  state.models = MODELS
  add("ses_1")
  const body = { version: 1, projectId, sessionId: "ses_1", text: "Synthetic prompt" }
  assert.deepEqual(await adapter.execute("chat.prompt", { ...body, model: { providerID: "acme", modelID: "m1", effort: "high" } }),
    { version: 1, accepted: true })
  const names = calls.map(([name]) => name).filter((name) => name === "session.switchModel" || name === "session.prompt")
  assert.deepEqual(names, ["session.switchModel", "session.prompt"], "switched first, so the turn cannot start on the old model")
  assert.deepEqual(calls.find(([name]) => name === "session.switchModel")[1],
    { sessionID: "ses_1", model: { id: "m1", providerID: "acme", variant: "high" } })
  // No effort selects the model's default: the variant is omitted, not carried over.
  calls.length = 0
  await adapter.execute("chat.prompt", { ...body, model: { providerID: "acme", modelID: "m2" } })
  assert.deepEqual(calls.find(([name]) => name === "session.switchModel")[1],
    { sessionID: "ses_1", model: { id: "m2", providerID: "acme" } })
})

test("a model or effort the model list does not report is refused before anything is switched or sent", async (t) => {
  const { adapter, projectId, add, calls, state } = await fixture(t)
  state.models = MODELS
  add("ses_1")
  const body = { version: 1, projectId, sessionId: "ses_1", text: "Synthetic prompt", mode: "plan" }
  await assert.rejects(adapter.execute("chat.prompt", { ...body, model: { providerID: "acme", modelID: "m1", effort: "extreme" } }), { code: "context_expired" })
  await assert.rejects(adapter.execute("chat.prompt", { ...body, model: { providerID: "acme", modelID: "m2", effort: "low" } }), { code: "context_expired" })
  await assert.rejects(adapter.execute("chat.prompt", { ...body, model: { providerID: "other", modelID: "m1" } }), { code: "context_expired" })
  assert.equal(calls.some(([name]) => ["session.switchAgent", "session.switchModel", "session.prompt"].includes(name)), false,
    "a refused model leaves the agent, the model and the chat untouched")
})

test("a model the session already runs is not switched again, unless an agent switch just happened", async (t) => {
  const { adapter, projectId, add, calls, state } = await fixture(t)
  state.models = MODELS
  add("ses_1", { agent: "build", model: { id: "m1", providerID: "acme", variant: "high" } })
  const body = { version: 1, projectId, sessionId: "ses_1", text: "Synthetic prompt" }
  await adapter.execute("chat.prompt", { ...body, mode: "build", model: { providerID: "acme", modelID: "m1", effort: "high" } })
  assert.equal(calls.some(([name]) => name === "session.switchModel" || name === "model.list"), false)
  // A different effort on the same model is a switch.
  await adapter.execute("chat.prompt", { ...body, model: { providerID: "acme", modelID: "m1" } })
  assert.deepEqual(calls.find(([name]) => name === "session.switchModel")[1],
    { sessionID: "ses_1", model: { id: "m1", providerID: "acme" } })
  // An agent switch may apply that agent's own model, so the requested model is re-applied after it.
  calls.length = 0
  await adapter.execute("chat.prompt", { ...body, mode: "plan", model: { providerID: "acme", modelID: "m1", effort: "high" } })
  const names = calls.map(([name]) => name).filter((name) => name.startsWith("session.switch") || name === "session.prompt")
  assert.deepEqual(names, ["session.switchAgent", "session.switchModel", "session.prompt"])
})

test("a prompt's Build or Plan mode switches the session agent before the prompt is sent", async (t) => {
  const { adapter, projectId, add, calls } = await fixture(t)
  add("ses_1")
  const body = { version: 1, projectId, sessionId: "ses_1", text: "Synthetic prompt" }
  for (const mode of ["plan", "build"]) {
    calls.length = 0
    assert.deepEqual(await adapter.execute("chat.prompt", { ...body, mode }), { version: 1, accepted: true })
    const names = calls.map(([name]) => name).filter((name) => name === "session.switchAgent" || name === "session.prompt")
    assert.deepEqual(names, ["session.switchAgent", "session.prompt"], "switched first, so the turn cannot start on the old agent")
    assert.deepEqual(calls.find(([name]) => name === "session.switchAgent")[1], { sessionID: "ses_1", agent: mode })
  }
  // Only OpenCode's own two agents are reachable: anything else fails the protocol schema.
  await assert.rejects(adapter.execute("chat.prompt", { ...body, mode: "general" }))
})

test("a mode the session already runs is not switched again, so history gains no redundant entry", async (t) => {
  const { adapter, projectId, add, calls } = await fixture(t)
  add("ses_1", { agent: "plan" })
  const body = { version: 1, projectId, sessionId: "ses_1", text: "Synthetic prompt" }
  await adapter.execute("chat.prompt", { ...body, mode: "plan" })
  assert.equal(calls.some(([name]) => name === "session.switchAgent"), false)
  assert.equal(calls.filter(([name]) => name === "session.prompt").length, 1)
  await adapter.execute("chat.prompt", { ...body, mode: "build" })
  assert.deepEqual(calls.find(([name]) => name === "session.switchAgent")[1], { sessionID: "ses_1", agent: "build" })
})

test("a failed agent switch fails the prompt instead of running it in the wrong mode", async (t) => {
  const { adapter, projectId, add, calls, state } = await fixture(t)
  add("ses_1")
  state.switchFails = true
  await assert.rejects(adapter.execute("chat.prompt", { version: 1, projectId, sessionId: "ses_1", text: "Synthetic prompt", mode: "plan" }))
  assert.equal(calls.some(([name]) => name === "session.prompt"), false, "never sent under whatever agent was current")
})

test("abort, and permission replies pass the explicit choice through unchanged", async (t) => {
  const { adapter, projectId, add, calls } = await fixture(t)
  add("ses_1")
  assert.deepEqual(await adapter.execute("chat.abort", { version: 1, projectId, sessionId: "ses_1" }), { version: 1, accepted: true })
  assert.deepEqual(calls.find(([name]) => name === "session.interrupt")[1], { sessionID: "ses_1" })
  for (const response of ["once", "always", "reject"]) {
    await adapter.execute("chat.permission.reply", { version: 1, projectId, sessionId: "ses_1", permissionId: "per_1", response })
    assert.deepEqual(calls.filter(([name]) => name === "permission.reply").at(-1)[1],
      { sessionID: "ses_1", requestID: "per_1", decision: response })
  }
  await assert.rejects(adapter.execute("chat.permission.reply",
    { version: 1, projectId, sessionId: "ses_1", permissionId: "per_1", response: "yes" }))
})

test("subtask sessions and unknown projects are denied before any mutation", async (t) => {
  const { adapter, projectId, add, calls } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" })
  for (const operation of ["chat.get", "chat.abort"]) {
    await assert.rejects(adapter.execute(operation, { version: 1, projectId, sessionId: "ses_child" }), ChatAccessError)
  }
  await assert.rejects(adapter.execute("chat.prompt", { version: 1, projectId, sessionId: "ses_child", text: "x" }), { code: "access_denied" })
  await assert.rejects(adapter.execute("chat.abort", { version: 1, projectId: crypto.randomUUID(), sessionId: "ses_1" }), { code: "context_expired" })
  assert.equal(calls.some(([name]) => name === "session.prompt" || name === "session.interrupt"), false)
})

test("the legacy session list reads root sessions of the plugin's directory", async (t) => {
  const { root, add, sessions, calls } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" })
  const reader = new OpenCodeSessionReader({ session: { list: async (input, options) => {
    calls.push(["reader.list", input, options]); return { data: [...sessions.values()], cursor: {} } } } }, root)
  assert.deepEqual(await reader.listSessions(), [{ id: "ses_1", title: "Chat ses_1", createdAt: NOW, updatedAt: NOW + 1 }])
  assert.deepEqual(calls.find(([name]) => name === "reader.list")[1], { directory: root, parentID: null, limit: 50 })
})

const user = (i, text = `question ${i}`) => ({ id: `msg_u${String(i).padStart(2, "0")}`, type: "user", time: { created: NOW + i * 10 }, text })
const assistant = (i, content, extra = {}) => ({ id: `msg_a${String(i).padStart(2, "0")}`, type: "assistant", agent: "build",
  model: { id: "model-1", providerID: "prov", variant: "high" }, time: { created: NOW + i * 10 + 5, completed: NOW + i * 10 + 9 }, content, ...extra })

test("chat.snapshot projects user and assistant history, oldest first, skipping bookkeeping messages", async (t) => {
  const { adapter, projectId, add, state, calls } = await fixture(t)
  add("ses_1")
  // Text and reasoning content carry no id of their own in OpenCode.
  state.messages.set("ses_1", [
    user(0), { id: "msg_sw", type: "agent-switched", time: { created: NOW + 1 }, agent: "plan" },
    assistant(0, [{ type: "reasoning", text: "thinking", time: { created: NOW, completed: NOW + 1 } }, { type: "text", text: "answer" }]),
    { id: "msg_loc", type: "location-switched", time: { created: NOW + 20 }, location: { directory: "/x" } },
    { id: "msg_future", type: "some-new-kind", time: { created: NOW + 21 } },
    user(1),
  ])
  const snapshot = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1" })
  assert.deepEqual(snapshot.messages.map((m) => [m.id, m.role]), [["msg_u00", "user"], ["msg_a00", "assistant"], ["msg_u01", "user"]])
  const reply = snapshot.messages[1]
  assert.equal(reply.text, "answer\n")
  assert.deepEqual(reply.parts.map((p) => p.type), ["reasoning", "text"])
  assert.equal(new Set(reply.parts.map((p) => p.id)).size, 2, "parts need distinct ids without native ones")
  assert.equal(reply.mode, "build")
  assert.equal(snapshot.messages[0].text, "question 0\n")
  assert.deepEqual(snapshot.model, { providerID: "prov", modelID: "model-1", effort: "high" })
  assert.equal(snapshot.status, "idle")
  assert.equal(snapshot.cursor, null)
  assert.equal("permission" in snapshot, false, "permissions only when the client opts in")
  assert.deepEqual(calls.find(([name]) => name === "message.list")[1], { sessionID: "ses_1", limit: 10, order: "desc" })
})

test("chat.snapshot pages older history through an opaque session-bound cursor and drops the model on older pages", async (t) => {
  const { adapter, projectId, add, state, calls } = await fixture(t)
  add("ses_1"); add("ses_2")
  state.messages.set("ses_1", Array.from({ length: 12 }, (_, i) => [user(i), assistant(i, [{ type: "text", text: `a${i}` }])]).flat())
  const first = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1" })
  assert.equal(first.messages.length, 10)
  assert.equal(first.messages.at(-1).id, "msg_a11")
  assert.match(first.cursor, /^[0-9a-f-]{36}$/)
  const older = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", cursor: first.cursor })
  assert.equal(calls.filter(([name]) => name === "message.list").at(-1)[1].cursor, "m:10")
  assert.equal(older.messages.length, 10)
  assert.equal("model" in older, false, "an older page must not report a stale model as current")
  const last = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", cursor: older.cursor })
  assert.equal(last.messages.length, 4)
  assert.equal(last.cursor, null, "a short page ends the history")
  await assert.rejects(adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_2", cursor: first.cursor }),
    { code: "context_expired" }, "a cursor cannot be replayed against another session")
})

test("chat.snapshot reports a running session as busy and only reads permissions when asked", async (t) => {
  const { adapter, projectId, add, state, calls } = await fixture(t)
  add("ses_1"); add("ses_2")
  state.messages.set("ses_1", [user(0)])
  state.active = { ses_1: { type: "running" } }
  state.permissions = [{ id: "per_2", sessionID: "ses_2", action: "bash", resources: ["rm -rf /"] },
    { id: "per_1", sessionID: "ses_1", action: "edit", resources: ["src/a.ts", "src/b.ts"] }]
  const plain = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1" })
  assert.equal(plain.status, "busy")
  assert.equal(calls.some(([name]) => name === "permission.list"), false)
  const withPermission = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includePermissions: true })
  assert.equal(withPermission.permission.id, "per_1", "only this session's request is shown")
  assert.equal(withPermission.permission.operation, "edit")
  assert.equal(withPermission.permission.pattern, "src/a.ts, src/b.ts")
  state.permissions = []
  assert.equal((await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includePermissions: true })).permission, null)
})

test("an active state this build has never seen is reported as unknown, never as idle", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0)])
  const status = async () => (await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1" })).status
  state.active = {}
  assert.equal(await status(), "idle", "only an absent entry is idle")
  state.active = { ses_1: { type: "running" } }
  assert.equal(await status(), "busy")
  state.active = { ses_1: { type: "retrying" } }
  assert.equal(await status(), "retry")
  // Collapsing an unfamiliar busy state into idle would let sessionSettled present a working
  // session's tool calls as abandoned. See ADR 0012.
  state.active = { ses_1: { type: "compacting" } }
  assert.equal(await status(), "unknown")
})

test("a settled session marks an interrupted tool abandoned, but only on evidence it is settled", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0), assistant(0, [
    { id: "bash1", type: "tool", name: "bash", time: { created: NOW }, state: { status: "running", input: { command: "sleep 1000" } } },
  ])])
  const activity = async (extra = {}) => (await adapter.execute("chat.snapshot",
    { version: 1, projectId, sessionId: "ses_1", includeTools: true, includeActivities: true, ...extra }))
    .messages[1].parts[0].activity.state
  const settledOptIns = { includePermissions: true, includeQuestions: true }
  assert.equal(await activity(settledOptIns), "cancelled", "idle, nothing pending, and both asked about")
  assert.equal(await activity({ includePermissions: true }), "running",
    "without asking about questions, 'none pending' may just mean 'never checked'")
  state.active = { ses_1: { type: "compacting" } }
  assert.equal(await activity(settledOptIns), "running", "an unfamiliar active state is not proof the session settled")
  state.active = {}
  // A form list that could not be read answers "no question", which is not the same as
  // "nothing is waiting on the user".
  state.forms = null
  assert.equal(await activity(settledOptIns), "running", "an unreadable form list cannot settle the session")
})

test("chat.snapshot refuses opt-ins it cannot honour and subtask sessions", async (t) => {
  const { adapter, projectId, add, state, calls } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" })
  state.messages.set("ses_1", [user(0)])
  for (const flag of ["includeTodos"]) {
    await assert.rejects(adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", [flag]: true }), ChatUnsupportedError, flag)
  }
  assert.equal(calls.some(([name]) => name === "message.list"), false, "refused before any history is read")
  await assert.rejects(adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_child" }), { code: "access_denied" })
})

function fakeEvents(events, { hangAfter = false } = {}) {
  return (signal) => ({ [Symbol.asyncIterator]() {
    let index = 0
    return { next: () => {
      if (signal.aborted) return Promise.resolve({ done: true, value: undefined })
      if (index < events.length) return Promise.resolve({ done: false, value: events[index++] })
      if (!hangAfter) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined })))
    } }
  } })
}

test("watchChat verifies membership up front and reports every event for its own session", async (t) => {
  const { adapter, add, state, projectId } = await fixture(t)
  add("ses_1"); add("ses_2")
  state.events = fakeEvents([
    { type: "server.connected" },
    { type: "provider.updated" },
    { type: "session.renamed", data: { sessionID: "ses_2" } },
    { type: "session.idle", data: { sessionID: "ses_1" } },
  ], { hangAfter: true })
  const changes = []
  const controller = new AbortController()
  const target = { version: 1, projectId, sessionId: "ses_1", subscriptionId: crypto.randomUUID() }
  const watch = adapter.watchChat(target, controller.signal, (reset) => changes.push(reset))
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  await watch
  assert.deepEqual(changes, [false, false], "server.connected once, then only ses_1's own event")
})

test("watchChat reports an event that carries its session only inside part or info", async (t) => {
  const { adapter, add, state, projectId } = await fixture(t)
  add("ses_1"); add("ses_2")
  // Matching only the top-level field would drop every message-level event and leave a chat
  // that refreshes when the session is renamed but not while a reply is being written.
  state.events = fakeEvents([
    { type: "server.connected" },
    { type: "message.part.updated", data: { part: { sessionID: "ses_1" } } },
    { type: "message.updated", data: { info: { id: "msg_1", sessionID: "ses_1" } } },
    { type: "message.part.updated", data: { part: { sessionID: "ses_2" } } },
    { type: "session.updated", data: { info: { id: "ses_1" } } },
  ], { hangAfter: true })
  const changes = []
  const controller = new AbortController()
  const watch = adapter.watchChat({ version: 1, projectId, sessionId: "ses_1", subscriptionId: crypto.randomUUID() },
    controller.signal, (reset) => changes.push(reset))
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  await watch
  assert.deepEqual(changes, [false, false, false, false],
    "server.connected, both of ses_1's message events and its own session event -- never ses_2's")
})

test("watchChat refuses a subtask target and denies a session outside the workspace", async (t) => {
  const { adapter, add, projectId } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" })
  const target = (sessionId, parentSessionId) => ({ version: 1, projectId, sessionId, parentSessionId, subscriptionId: crypto.randomUUID() })
  await assert.rejects(adapter.watchChat(target("ses_1", "ses_0"), new AbortController().signal, () => {}), ChatUnsupportedError)
  await assert.rejects(adapter.watchChat({ ...target("ses_child", undefined), parentSessionId: undefined },
    new AbortController().signal, () => {}), { code: "access_denied" })
})

test("watchChat ends the stream as fatal on a shutdown event", async (t) => {
  const { adapter, add, state, projectId } = await fixture(t)
  add("ses_1")
  state.events = fakeEvents([{ type: "server.connected" }, { type: "location.shutdown" }])
  await assert.rejects(adapter.watchChat({ version: 1, projectId, sessionId: "ses_1", subscriptionId: crypto.randomUUID() },
    new AbortController().signal, () => {}), { message: "Chat source disposed" })
})

test("readChat re-reads a fresh chat.snapshot, forwarding every opt-in the subscription negotiated", async (t) => {
  const { adapter, add, calls, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0), assistant(0, [
    { id: "read1", type: "tool", name: "read", time: { created: NOW, completed: NOW + 1 },
      state: { status: "completed", input: { filePath: "/x/a.dart" }, content: [{ type: "text", text: "body" }] } },
    { id: "code1", type: "tool", name: "execute", time: { created: NOW, completed: NOW + 1 },
      state: { status: "completed", input: { code: "console.log(3)" }, content: [{ type: "text", text: "3" }] } },
  ])])
  const projectId = (await adapter.execute("project.list", {})).projects[0].id
  const target = { version: 1, projectId, sessionId: "ses_1", subscriptionId: crypto.randomUUID(),
    includeTools: true, includeShell: true, includeCode: true, includeActivities: true, includeSubtasks: true,
    includeImages: true, includePermissions: true, includeQuestions: true }
  const snapshot = await adapter.readChat(target, new AbortController().signal)
  assert.equal(snapshot.chat.id, "ses_1")
  // A stream read that dropped these would hand the client a thinner snapshot than the one it
  // just fetched by hand, and the client merges updates over its own history.
  assert.equal(snapshot.messages[1].parts[0].tool.operation, "read")
  assert.equal(snapshot.messages[1].parts[0].activity.kind, "read")
  assert.deepEqual(snapshot.messages[1].parts[1].tool.code, { source: "console.log(3)", output: "3", truncated: false })
  assert.equal(snapshot.messages[1].parts[1].activity.kind, "execute")
  assert.equal("permission" in snapshot, true)
  assert.equal("question" in snapshot, true, "a pending question stays answerable while streaming")
  assert.equal(calls.some(([name]) => name === "permission.list"), true)
  assert.equal(calls.some(([name]) => name === "form.list"), true)
})

test("readChat drops only the todos opt-in, which the snapshot refuses outright", async (t) => {
  const { adapter, add } = await fixture(t)
  add("ses_1")
  const projectId = (await adapter.execute("project.list", {})).projects[0].id
  const target = { version: 1, projectId, sessionId: "ses_1", subscriptionId: crypto.randomUUID(), includeTodos: true }
  // Refusing the whole stream over a flag the connector never advertised would be worse than
  // serving the rest of the snapshot without it.
  const snapshot = await adapter.readChat(target, new AbortController().signal)
  assert.equal("todos" in snapshot, false)
  await assert.rejects(adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeTodos: true }),
    ChatUnsupportedError, "a direct snapshot still refuses it rather than ignoring it")
})

test("chat.models groups model.list by provider, names each from provider.get, and lists effort levels", async (t) => {
  const { adapter, projectId, state, calls } = await fixture(t)
  state.models = [
    { id: "m1", modelID: "m1", providerID: "acme", name: "Acme One", variants: [{ id: "low" }, { id: "high" }, { id: "low" }] },
    { id: "m2", modelID: "m2", providerID: "acme", name: "Acme Two" },
    { id: "m3", modelID: "m3", providerID: "zen", name: "Zen Free" },
  ]
  state.providers.set("acme", "Acme Labs")
  // zen has no provider.get entry -- its models must still be listed, by their bare id.
  const result = await adapter.execute("chat.models", { version: 1, projectId })
  assert.deepEqual(result.models, [
    { providerID: "acme", providerName: "Acme Labs", modelID: "m1", modelName: "Acme One", effortLevels: ["low", "high"] },
    { providerID: "acme", providerName: "Acme Labs", modelID: "m2", modelName: "Acme Two" },
    { providerID: "zen", providerName: "zen", modelID: "m3", modelName: "Zen Free" },
  ])
  assert.equal(calls.filter(([name]) => name === "provider.get").length, 2, "one lookup per distinct provider, not per model")
  assert.deepEqual(calls.find(([name]) => name === "location.get")[1], { location: { directory: (await adapter.execute("project.list", {})).projects[0].path } })
})

test("chat.models bounds effort levels, providers and models", async (t) => {
  const { adapter, projectId, state } = await fixture(t)
  state.models = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, modelID: `m${i}`, providerID: `p${i % 30}`, name: `M ${i}`,
    variants: Array.from({ length: 15 }, (_, j) => ({ id: `e${j}` })) }))
  for (let i = 0; i < 30; i++) state.providers.set(`p${i}`, `P ${i}`)
  const result = await adapter.execute("chat.models", { version: 1, projectId })
  assert.equal(result.models.length, 200)
  assert.equal(result.models[0].effortLevels.length, 10)
  // Providers beyond the bounded lookup fall back to their own id rather than growing unbounded work.
  const fallenBack = result.models.filter((m) => m.providerName === m.providerID)
  assert.ok(fallenBack.length > 0 && fallenBack.length < 200, "some, but not all, providers hit the lookup bound")
})

test("chat.snapshot projects a shell tool call, and a non-shell tool falls back to a bounded summary", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [
    user(0),
    assistant(0, [
      { id: "read1", type: "tool", name: "read", time: { created: NOW, completed: NOW + 1 },
        state: { status: "completed", input: { filePath: "/x/a.dart" }, content: [{ type: "text", text: "file body" }] } },
      { id: "bash1", type: "tool", name: "bash", time: { created: NOW, ran: NOW, completed: NOW + 2 },
        state: { status: "completed", input: { command: "ls -la", description: "list files" }, content: [{ type: "text", text: "a.dart\nb.dart" }] } },
    ]),
  ])
  const plain = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1" })
  assert.equal("parts" in plain.messages[1], false, "tools are only projected when the client opts in")
  const withTools = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeTools: true })
  assert.equal(withTools.messages[1].parts[0].tool.operation, "read")
  assert.equal(withTools.messages[1].parts[0].tool.description, "a.dart")
  assert.equal("shell" in withTools.messages[1].parts[1].tool, false, "shell command/output need their own opt-in")
  const withShell = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeTools: true, includeShell: true })
  assert.deepEqual(withShell.messages[1].parts[1].tool.shell, { command: "ls -la", output: "a.dart\nb.dart", truncated: false })
  assert.equal(JSON.stringify(withShell).includes("filePath"), false, "raw tool input never crosses the wire, only the derived description")
})

test("chat.snapshot projects V2 shell, patch, read, fetch and execute inputs without tool bodies", async (t) => {
  const { adapter, projectId, add, state, root } = await fixture(t)
  add("ses_1")
  const native = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-v2-tools-v1.json", import.meta.url), "utf8"))
  native.nativeMessage.content[0].state.input.patchText = native.nativeMessage.content[0].state.input.patchText.replace("/workspace/", `${root}/`)
  native.nativeMessage.content[2].state.input.path = path.join(root, "mobile/lib/main.dart")
  native.nativeMessage.content[5].state.input.path = path.join(root, "mobile/lib")
  state.messages.set("ses_1", [user(0), { ...native.nativeMessage, id: "msg_v2_tools", sessionID: "ses_1" }])
  const snapshot = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1",
    includeTools: true, includeShell: true })
  assert.deepEqual(snapshot.messages[1].parts.map((part) => part.tool.description),
    ["lib/example.dart", undefined, "mobile/lib/main.dart", "docs.example.test", "Run code", '"needle" in mobile/lib'])
  assert.equal(snapshot.messages[1].parts[1].tool.shell.output, "v2 shell\n")
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_"), false)
})

const multiselectField = (key, title, options, extra = {}) =>
  ({ key, type: "multiselect", title, options, custom: false, ...extra })
const stringField = (key, title, options, extra = {}) =>
  ({ key, type: "string", title, options, custom: false, ...extra })

test("chat.questions surfaces a recognized question-shaped form and hides it once answered", async (t) => {
  const { adapter, projectId, add, state, calls } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0)])
  const noQuestion = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeQuestions: true })
  assert.equal(noQuestion.question, null)
  state.forms = [{ id: "frm_1", sessionID: "ses_1", title: "Questions", fields: [
    multiselectField("q0", "Which approach?", [{ value: "a", label: "Fast", description: "quicker" }, { value: "b", label: "Thorough" }]),
    stringField("q1", "Anything else?", [{ value: "no", label: "No" }], { custom: true }),
  ] }]
  const withQuestion = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeQuestions: true })
  assert.equal(withQuestion.question.id, "frm_1")
  assert.deepEqual(withQuestion.question.questions, [
    { header: "", question: "Which approach?", options: [{ label: "Fast", description: "quicker" }, { label: "Thorough" }], multiple: true, custom: false },
    { header: "", question: "Anything else?", options: [{ label: "No" }], multiple: false, custom: true },
  ])
  const before = calls.filter(([name]) => name === "form.list").length
  const plain = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1" })
  assert.equal("question" in plain, false, "only read when the client opts in")
  assert.equal(calls.filter(([name]) => name === "form.list").length, before, "not read at all without the opt-in")
})

test("a form with any unrecognized field is never surfaced as a question", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0)])
  for (const fields of [
    [multiselectField("q0", "Pick one", [{ value: "a", label: "A" }]), { key: "q1", type: "boolean", title: "Confirm?" }],
    [{ ...multiselectField("q0", "Pick one", [{ value: "a", label: "A" }]), hidden: true }],
    [{ ...multiselectField("q0", "Pick one", [{ value: "a", label: "A" }]), when: [{ key: "x", op: "eq", value: "y" }] }],
    [multiselectField("q0", "Pick one", [])],
    [{ key: "q0", type: "multiselect", options: [{ value: "a", label: "A" }] }], // no title
  ]) {
    state.forms = [{ id: "frm_bad", sessionID: "ses_1", title: "Q", fields }]
    const snapshot = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeQuestions: true })
    assert.equal(snapshot.question, null, JSON.stringify(fields))
  }
})

test("chat.question.reply resolves indices to the form's own option values, never labels", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0)])
  state.forms = [{ id: "frm_1", sessionID: "ses_1", title: "Questions", fields: [
    multiselectField("q0", "Which approach?", [{ value: "opt-a", label: "Fast" }, { value: "opt-b", label: "Thorough" }], { maxItems: 2 }),
    stringField("q1", "Confirm?", [{ value: "y", label: "Yes" }], { custom: true }),
  ] }]
  const result = await adapter.execute("chat.question.reply", { version: 1, projectId, sessionId: "ses_1", questionId: "frm_1",
    response: "answer", answers: [{ selected: [0, 1] }, { selected: [0] }] })
  assert.deepEqual(result, { version: 1, accepted: true })
  assert.deepEqual(state.formOutcomes, [{ id: "frm_1", answer: { q0: ["opt-a", "opt-b"], q1: "y" } }])
  assert.equal(state.forms.length, 0, "answering removes it from the pending list")
})

test("chat.question.reply forwards free text only when the field's custom flag allows it", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0)])
  state.forms = [{ id: "frm_1", sessionID: "ses_1", title: "Q", fields: [
    multiselectField("q0", "Pick or type", [{ value: "a", label: "A" }], { custom: true }),
  ] }]
  await adapter.execute("chat.question.reply", { version: 1, projectId, sessionId: "ses_1", questionId: "frm_1",
    response: "answer", answers: [{ text: "my own answer" }] })
  assert.deepEqual(state.formOutcomes, [{ id: "frm_1", answer: { q0: ["my own answer"] } }])
  state.forms = [{ id: "frm_2", sessionID: "ses_1", title: "Q", fields: [
    multiselectField("q0", "Pick only", [{ value: "a", label: "A" }], { custom: false }),
  ] }]
  await assert.rejects(adapter.execute("chat.question.reply", { version: 1, projectId, sessionId: "ses_1", questionId: "frm_2",
    response: "answer", answers: [{ text: "not allowed" }] }), { code: "context_expired" })
})

test("chat.question.reply rejects a mismatched answer count, an out-of-range index, and a stale id", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0)])
  state.forms = [{ id: "frm_1", sessionID: "ses_1", title: "Q", fields: [
    multiselectField("q0", "Pick", [{ value: "a", label: "A" }]),
    multiselectField("q1", "Pick", [{ value: "b", label: "B" }]),
  ] }]
  await assert.rejects(adapter.execute("chat.question.reply", { version: 1, projectId, sessionId: "ses_1", questionId: "frm_1",
    response: "answer", answers: [{ selected: [0] }] }), { code: "context_expired" }, "too few answers")
  await assert.rejects(adapter.execute("chat.question.reply", { version: 1, projectId, sessionId: "ses_1", questionId: "frm_1",
    response: "answer", answers: [{ selected: [5] }, { selected: [0] }] }), { code: "context_expired" }, "out of range")
  await assert.rejects(adapter.execute("chat.question.reply", { version: 1, projectId, sessionId: "ses_1", questionId: "frm_stale",
    response: "answer", answers: [{ selected: [0] }, { selected: [0] }] }), { code: "context_expired" }, "stale id")
  assert.equal(state.forms.length, 1, "a failed reply never touches the pending form")
})

test("chat.question.reply reject cancels the form and records every question as declined", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0)])
  state.forms = [{ id: "frm_1", sessionID: "ses_1", title: "Q", fields: [multiselectField("q0", "Pick", [{ value: "a", label: "A" }])] }]
  const result = await adapter.execute("chat.question.reply", { version: 1, projectId, sessionId: "ses_1", questionId: "frm_1", response: "reject" })
  assert.deepEqual(result, { version: 1, accepted: true })
  assert.deepEqual(state.formOutcomes, [{ id: "frm_1", cancelled: true }])
})

test("a string field given more than one selected index fails closed rather than picking one", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0)])
  state.forms = [{ id: "frm_1", sessionID: "ses_1", title: "Q", fields: [
    stringField("q0", "Pick one", [{ value: "a", label: "A" }, { value: "b", label: "B" }]) ] }]
  await assert.rejects(adapter.execute("chat.question.reply", { version: 1, projectId, sessionId: "ses_1", questionId: "frm_1",
    response: "answer", answers: [{ selected: [0, 1] }] }), { code: "context_expired" })
})

const taskPart = (id, status, extra = {}) => ({ id, type: "tool", name: "task",
  time: { created: NOW, ...(status !== "pending" ? { completed: NOW + 1 } : {}) },
  state: { status, input: { description: "Investigate the bug", subagent_type: "general" }, ...extra } })

test("chat.snapshot resolves a completed subtask against the child session's real history", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" })
  state.messages.set("ses_1", [user(0),
    assistant(0, [taskPart("task1", "completed", { content: [{ type: "text", text: "done" }], metadata: { sessionId: "ses_child" } })])])
  state.messages.set("ses_child", [
    { id: "cu0", type: "user", time: { created: NOW }, text: "go" },
    { id: "ca0", type: "assistant", agent: "general", model: { id: "m", providerID: "p" },
      time: { created: NOW + 1, completed: NOW + 5 }, content: [{ type: "text", text: "found it" }] },
  ])
  const plain = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1" })
  assert.equal("parts" in plain.messages[1], false, "subtasks are only projected when the client opts in")
  const withSubtasks = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeSubtasks: true })
  const subtask = withSubtasks.messages[1].parts[0]
  assert.equal(subtask.type, "subtask")
  assert.deepEqual(subtask.task, { title: "Investigate the bug", agent: "general", status: "completed", background: false,
    sessionId: "ses_child", stats: { toolCalls: 0, complete: true, durationMs: 5 } })
})

test("a task still running in stored history stops looking live when its child stops", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" })
  state.messages.set("ses_child", [user(1)])
  const read = async () => (await adapter.execute("chat.snapshot", {
    version: 1, projectId, sessionId: "ses_1", includeSubtasks: true,
  })).messages[1].parts[0].task.status
  for (const background of [false, true]) {
    state.messages.set("ses_1", [user(0), assistant(0, [
      taskPart("task1", "running", { metadata: { sessionId: "ses_child", background } }),
    ])])
    state.active = { ses_child: { type: "running" } }
    assert.equal(await read(), "running")
    state.active = {}
    assert.equal(await read(), "unknown", "a stale parent tool cannot keep the mobile spinner live")
  }
})

test("chat.subtask.snapshot views the child's own transcript, only through its claimed parent", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" }); add("ses_other")
  state.messages.set("ses_child", [{ id: "cu0", type: "user", time: { created: NOW }, text: "go" }])
  const view = await adapter.execute("chat.subtask.snapshot", { version: 1, projectId, sessionId: "ses_child", parentSessionId: "ses_1" })
  assert.equal(view.chat.id, "ses_child")
  assert.equal(view.chat.parentId, "ses_1")
  assert.equal(view.messages.length, 1)
  await assert.rejects(adapter.execute("chat.subtask.snapshot",
    { version: 1, projectId, sessionId: "ses_child", parentSessionId: "ses_other" }), { code: "access_denied" }, "wrong claimed parent")
  await assert.rejects(adapter.execute("chat.subtask.snapshot",
    { version: 1, projectId, sessionId: "ses_1", parentSessionId: "ses_other" }), { code: "access_denied" }, "not a subtask at all")
})

test("an unresolvable subtask (missing, foreign, or a running one still to start) degrades without discarding the parent chat", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1"); add("ses_child", { parentID: "ses_1" }); add("ses_foreign")
  state.messages.set("ses_1", [user(0), assistant(0, [
    taskPart("task_missing", "completed", { content: [{ type: "text", text: "x" }], metadata: { sessionId: "ses_gone" } }),
    taskPart("task_foreign", "completed", { content: [{ type: "text", text: "x" }], metadata: { sessionId: "ses_foreign" } }),
    taskPart("task_pending", "pending", { background: true }),
    taskPart("task_running_bg", "running", { metadata: { sessionId: "ses_gone_bg", background: true } }),
  ])])
  const snapshot = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeSubtasks: true })
  const parts = snapshot.messages[1].parts
  assert.equal(parts[0].task.status, "completed", "a missing child falls back to the tool's own reported status")
  assert.equal("sessionId" in parts[0].task, false)
  assert.equal(parts[1].task.status, "completed", "a session that exists but isn't this parent's child is treated the same as missing")
  assert.equal(parts[2].task.status, "pending", "no session id at all (still pending) is left as reported, not marked unknown")
  assert.equal(parts[3].task.status, "unknown", "a background task whose claimed child never resolves is marked unknown, not left running forever")
})

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg=="

test("chat.snapshot projects activity state for a completed and a still-streaming tool", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [user(0), assistant(0, [
    { id: "read1", type: "tool", name: "read", time: { created: NOW, completed: NOW + 1 },
      state: { status: "completed", input: { filePath: "/x/a.dart" }, content: [{ type: "text", text: "body" }] } },
    { id: "read2", type: "tool", name: "read", time: { created: NOW },
      state: { status: "streaming", input: "{\"filePath\"" } },
  ])])
  const snapshot = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1",
    includeTools: true, includeActivities: true })
  const parts = snapshot.messages[1].parts
  assert.equal(parts[0].activity.kind, "read")
  assert.equal(parts[0].activity.state, "completed")
  assert.equal(parts[1].activity.kind, "read")
  assert.equal(parts[1].activity.state, "running", "a streaming tool call is presented as running")
})

test("chat.snapshot decodes a real inline image attachment into a bounded JPEG preview", async (t) => {
  const { adapter, projectId, add, state } = await fixture(t)
  add("ses_1")
  state.messages.set("ses_1", [
    { id: "msg_u0", type: "user", time: { created: NOW }, text: "look at this",
      files: [{ name: "pixel.png", mime: "image/png", data: TINY_PNG_BASE64, source: { type: "inline" } }] },
  ])
  const plain = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1" })
  assert.equal("parts" in plain.messages[0], false, "images are only decoded when the client opts in")
  const withImages = await adapter.execute("chat.snapshot", { version: 1, projectId, sessionId: "ses_1", includeImages: true })
  const imagePart = withImages.messages[0].parts.find((p) => p.type === "image")
  assert.ok(imagePart, "the real png decoded into an image part")
  assert.equal(imagePart.image.mime, "image/jpeg")
  assert.ok(imagePart.image.data.length > 0)
})
