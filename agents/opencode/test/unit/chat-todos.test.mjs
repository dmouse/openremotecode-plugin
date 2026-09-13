import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"
import { todoSummaries } from "../../dist/chat-message.js"
import { LiveParts } from "../../dist/live-parts.js"

const fixture = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-todos-v1.json", import.meta.url), "utf8"))

test("todoSummaries maps only the display fields, never the native priority", () => {
  assert.deepEqual(todoSummaries(fixture.nativeTodos), fixture.response.todos)
  assert.equal(JSON.stringify(todoSummaries(fixture.nativeTodos)).includes("PRIVATE_"), false)
  assert.equal(JSON.stringify(todoSummaries(fixture.nativeTodos)).includes("priority"), false)
})

test("todoSummaries strips control characters and bidi overrides, and bounds text", () => {
  const [todo] = todoSummaries([{ id: "t", content: "Run\x1b[31m red‮ text", status: "pending" }])
  // eslint-disable-next-line no-control-regex -- asserting control/bidi-override characters were stripped
  assert.equal(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/u.test(todo.content), false)
  assert.equal(todoSummaries([{ id: "t", content: "x".repeat(500), status: "pending" }])[0].content.length, 256)
})

test("todoSummaries identifies an item by its position, since the pinned binary sends no id", () => {
  // The live 1.18.30 response shape: no id field at all.
  assert.deepEqual(todoSummaries([{ content: "First", status: "pending", priority: "high" }]),
    [{ id: "todo-0", content: "First", status: "pending" }])
  // A dropped item does not renumber the ones after it: an id is the item's
  // place in OpenCode's own list, not a count of what survived.
  assert.deepEqual(todoSummaries([{ content: "   ", status: "pending" }, { content: "Second", status: "pending" }]),
    [{ id: "todo-1", content: "Second", status: "pending" }])
  // A future build that does supply an id is preferred over the positional one.
  assert.deepEqual(todoSummaries([{ id: "tod_native", content: "First", status: "pending" }]),
    [{ id: "tod_native", content: "First", status: "pending" }])
  // A blank or oversized native id falls back rather than dropping the item.
  assert.deepEqual(todoSummaries([{ id: "", content: "First", status: "pending" },
    { id: "x".repeat(129), content: "Second", status: "pending" }]),
    [{ id: "todo-0", content: "First", status: "pending" }, { id: "todo-1", content: "Second", status: "pending" }])
})

test("todoSummaries drops unusable items and bounds the list without leaking a native shape", () => {
  assert.deepEqual(todoSummaries(undefined), [])
  assert.deepEqual(todoSummaries({ todos: [] }), [])
  assert.deepEqual(todoSummaries("not-a-list"), [])
  assert.deepEqual(todoSummaries([
    null, "string", { content: "   ", status: "pending" }, { content: "", status: "pending" },
    { content: "Kept", status: "completed" },
    { id: "dupe", content: "First", status: "pending" }, { id: "dupe", content: "Duplicate id", status: "pending" },
  ]), [{ id: "todo-4", content: "Kept", status: "completed" },
    { id: "dupe", content: "First", status: "pending" }])
  const long = Array.from({ length: 150 }, () => ({ content: "Task", status: "pending" }))
  assert.equal(todoSummaries(long).length, 100)
  assert.equal(todoSummaries(long).at(-1).id, "todo-99", "the cap keeps OpenCode's own order, it does not sample")
})

test("LiveParts captures todo.updated as a whole-list replacement for its own session only", () => {
  const live = new LiveParts("ses_todos")
  assert.equal(live.todos, undefined)
  live.capture({ type: "todo.updated", properties: { sessionID: "ses_other", todos: fixture.nativeTodos } })
  assert.equal(live.todos, undefined, "another session's list is never captured")
  live.capture({ type: "todo.updated", properties: { sessionID: "ses_todos", todos: fixture.nativeTodos } })
  assert.deepEqual(live.todos, fixture.response.todos)
  live.capture({ type: "todo.updated", properties: { sessionID: "ses_todos",
    todos: [{ content: "Read the relay contract", status: "completed" }] } })
  assert.deepEqual(live.todos, [{ id: "todo-0", content: "Read the relay contract", status: "completed" }],
    "a later event replaces the list rather than merging into it")
  live.clear()
  assert.equal(live.todos, undefined)
})

test("LiveParts.project includes todos only when requested, preferring the live list", () => {
  const live = new LiveParts("ses_todos")
  const snapshot = { version: 1, chat: fixture.response.chat, status: "idle", cursor: null, messages: [],
    todos: [{ id: "todo-0", content: "Remembered", status: "pending" }] }
  assert.deepEqual(live.project(snapshot, { includeTodos: true }).todos, snapshot.todos,
    "with no event captured yet, the snapshot's own read stands")
  live.capture({ type: "todo.updated", properties: { sessionID: "ses_todos", todos: fixture.nativeTodos } })
  assert.deepEqual(live.project(snapshot, { includeTodos: true }).todos, fixture.response.todos)
  const notRequested = live.project(snapshot, { includeTodos: false })
  assert.equal(Object.hasOwn(notRequested, "todos"), false, "never carries over a stale remembered value")
  assert.deepEqual(live.project({ ...snapshot, todos: undefined }, { includeTodos: true }).todos, fixture.response.todos)
})

async function todoAdapter(t, { todos = fixture.nativeTodos, fail = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "chat-todos-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = { id: "ses_todos", title: "Todo presentation", directory: root, time: { updated: 1000 } }
  const reads = []
  const client = {
    session: {
      get: async () => ({ data: session, response: { ok: true } }),
      status: async () => ({ data: {}, response: { ok: true } }),
      messages: async ({ url }) => url
        ? { data: { data: [], cursor: {} }, response: { ok: true } }
        : { data: [], response: new Response(null) },
      todo: async (options) => {
        reads.push(options)
        if (fail) throw new Error("native failure")
        return { data: todos, response: { ok: true } }
      },
    },
  }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  return { adapter, reads, root, body: { version: 1, projectId: projects[0].id, sessionId: session.id } }
}

test("chat.snapshot reads the session's todo list only when opted in", async (t) => {
  const { adapter, reads, root, body } = await todoAdapter(t)
  const withTodos = await adapter.execute("chat.snapshot", { ...body, includeTodos: true })
  assert.deepEqual(withTodos.todos, fixture.response.todos)
  assert.deepEqual(reads.at(-1).path, { id: "ses_todos" })
  assert.deepEqual(reads.at(-1).query, { directory: root })
  assert.ok(reads.at(-1).signal instanceof AbortSignal)
  for (const optOut of [{}, { includeTodos: false }]) {
    const snapshot = await adapter.execute("chat.snapshot", { ...body, ...optOut })
    assert.equal(Object.hasOwn(snapshot, "todos"), false)
  }
  assert.equal(reads.length, 1, "a client that didn't opt in never triggers the native read")
})

test("chat.snapshot reports an empty list rather than leaking a native todo failure", async (t) => {
  const { adapter, body } = await todoAdapter(t, { fail: true })
  assert.deepEqual((await adapter.execute("chat.snapshot", { ...body, includeTodos: true })).todos, [])
})

test("chat.snapshot presents an empty native list as an empty list, not an absent field", async (t) => {
  const { adapter, body } = await todoAdapter(t, { todos: [] })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeTodos: true })
  assert.equal(Object.hasOwn(snapshot, "todos"), true)
  assert.deepEqual(snapshot.todos, [])
})
