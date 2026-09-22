import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { ChatAccessError, ChatUnsupportedError } from "../../dist/chat-adapter.js"
import { OpenCodeV2ChatAdapter } from "../../dist/v2/chat-adapter.js"
import { OpenCodeV2SessionReader } from "../../dist/v2/session-reader.js"

const NOW = 1_788_115_200_000

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "v2-chat-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const other = path.join(root, "other"); await mkdir(other)
  const sessions = new Map()
  const calls = []
  const state = { active: {}, permissions: [], messages: new Map(), models: [], providers: new Map(),
    forms: [], formOutcomes: [],
    // Overridden per test; default yields nothing so a subscription just idles until aborted.
    events: (signal) => ({ [Symbol.asyncIterator]: () => ({
      next: () => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ done: true, value: undefined }))) }) }) }
  const add = (id, extra = {}) => sessions.set(id, { id, title: `Chat ${id}`, projectID: "p",
    time: { created: NOW, updated: NOW + 1 }, location: { directory: root }, ...extra })
  const client = {
    session: {
      list: async (input, options) => {
        calls.push(["session.list", input, options])
        const data = [...sessions.values()].filter((s) => s.location.directory === input.directory)
        // Real v2 always returns a next cursor, even on the last page.
        return { data: data.slice(0, input.limit), cursor: { next: "native-next", previous: "native-prev" } }
      },
      create: async (input, options) => {
        calls.push(["session.create", input, options])
        add("ses_new", { location: { directory: input.location.directory } })
        return sessions.get("ses_new")
      },
      get: async (input, options) => {
        calls.push(["session.get", input, options])
        const found = sessions.get(input.sessionID)
        // Real v2 rejects with a plain tagged object, not an Error.
        if (!found) throw { _tag: "SessionNotFoundError", sessionID: input.sessionID, message: "Session not found" }
        return found
      },
      prompt: async (input, options) => { calls.push(["session.prompt", input, options]); return {} },
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
      // Newest first, like real v2; a cursor continues from where the previous page stopped.
      const ordered = [...all].reverse()
      const start = input.cursor ? Number(input.cursor.replace("m:", "")) : 0
      const data = ordered.slice(start, start + input.limit)
      return { data, cursor: { next: `m:${start + input.limit}`, previous: null } }
    } },
    permission: { list: async (input, options) => { calls.push(["permission.list", input, options]); return state.permissions },
      reply: async (input, options) => { calls.push(["permission.reply", input, options]) } },
  }
  const adapter = new OpenCodeV2ChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  return { root, other, sessions, add, calls, adapter, projectId: projects[0].id, state }
}

test("advertises exactly the operations it implements", async (t) => {
  const { adapter } = await fixture(t)
  assert.deepEqual([...adapter.capabilities].sort(), ["chat.abort", "chat.activities", "chat.create", "chat.get",
    "chat.images", "chat.list", "chat.models", "chat.permission.reply", "chat.permissions", "chat.prompt",
    "chat.question.reply", "chat.questions", "chat.shell", "chat.snapshot", "chat.subtask.snapshot", "chat.tools",
    "project.list", "project.open"])
  assert.equal(adapter.capabilities.includes("chat.prompt.mode"), false)
})

test("operations outside the implemented set fail as unsupported, not as generic errors", async (t) => {
  const { adapter, projectId, add } = await fixture(t)
  add("ses_1")
  for (const [operation, body] of [
    ["chat.fork", { version: 1, projectId, sessionId: "ses_1" }],
    ["chat.rename", { version: 1, projectId, sessionId: "ses_1", title: "x" }],
    ["chat.delete", { version: 1, projectId, sessionId: "ses_1" }],
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
  assert.equal(only.cursor, null, "v2's always-present next cursor must not become an endless page")
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
  const leaky = new OpenCodeV2ChatAdapter({ session: { list: async () => ({ data: [sessions.get("ses_1")], cursor: {} }),
    get: async () => sessions.get("ses_1") }, permission: {} }, path.dirname(other))
  const { projects } = await leaky.execute("project.list", {})
  await assert.rejects(leaky.execute("chat.list", { version: 1, projectId: projects[0].id }), { code: "access_denied" })
  await assert.rejects(adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_1" }), { code: "access_denied" })
})

test("chat.create verifies ownership and get maps a missing session to chat_not_found", async (t) => {
  const { adapter, projectId, root, calls } = await fixture(t)
  const created = await adapter.execute("chat.create", { version: 1, projectId })
  assert.equal(created.chat.id, "ses_new")
  assert.deepEqual(calls.find(([name]) => name === "session.create")[1], { location: { directory: root } })
  assert.deepEqual(await adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_new" }), created)
  await assert.rejects(adapter.execute("chat.get", { version: 1, projectId, sessionId: "ses_missing" }), { code: "chat_not_found" })
})

test("prompt sends text only and refuses mode or model it cannot honour", async (t) => {
  const { adapter, projectId, add, calls } = await fixture(t)
  add("ses_1")
  const body = { version: 1, projectId, sessionId: "ses_1", text: "Synthetic prompt" }
  assert.deepEqual(await adapter.execute("chat.prompt", body), { version: 1, accepted: true })
  const [, input, options] = calls.find(([name]) => name === "session.prompt")
  assert.deepEqual(input, { sessionID: "ses_1", text: "Synthetic prompt" })
  assert.ok(options.signal instanceof AbortSignal)
  await assert.rejects(adapter.execute("chat.prompt", { ...body, mode: "plan" }), ChatUnsupportedError)
  await assert.rejects(adapter.execute("chat.prompt", { ...body, model: { providerID: "p", modelID: "m" } }), ChatUnsupportedError)
  assert.equal(calls.filter(([name]) => name === "session.prompt").length, 1, "refused prompts are never sent")
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
  const reader = new OpenCodeV2SessionReader({ session: { list: async (input, options) => {
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
  // Text and reasoning content carry no id of their own in OpenCode 2.0.
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

test("readChat re-reads a fresh chat.snapshot, forwarding only the permissions opt-in", async (t) => {
  const { adapter, add, calls } = await fixture(t)
  add("ses_1")
  const target = { version: 1, projectId: crypto.randomUUID(), sessionId: "ses_1", subscriptionId: crypto.randomUUID(), includePermissions: true }
  const projectId = (await adapter.execute("project.list", {})).projects[0].id
  const snapshot = await adapter.readChat({ ...target, projectId }, new AbortController().signal)
  assert.equal(snapshot.chat.id, "ses_1")
  assert.deepEqual(snapshot.messages, [])
  assert.equal("permission" in snapshot, true)
  assert.equal(calls.some(([name]) => name === "permission.list"), true)
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
