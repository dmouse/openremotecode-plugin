import assert from "node:assert/strict"
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { chatMessageContent } from "../../dist/chat-message.js"
import { subtaskStats } from "../../dist/chat-subtask.js"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"

const fixture = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-subtasks-v1.json", import.meta.url), "utf8"))
const task = fixture.response.messages[0].parts[1].task
test("normalization matches the shared contract and only opts in on request", () => {
  const { id: _id, role, ...expected } = fixture.response.messages[0]
  assert.deepEqual(chatMessageContent(role, fixture.nativeParts, new Map([["p1", task]])), expected)
  const legacy = chatMessageContent(role, fixture.nativeParts)
  assert.equal(legacy.parts, undefined)
  assert.equal(legacy.text, expected.text)
  assert.equal(JSON.stringify(expected).includes("synthetic-local-only"), false)
})

function childMessages(id = "ses_child") {
  return [{ info: { id: `${id}_user`, role: "user", sessionID: id, time: { created: 1000 } }, parts: [] },
    { info: { id: `${id}_assistant`, role: "assistant", sessionID: id, time: { created: 1001, completed: 83000 } },
      parts: Array.from({ length: 15 }, (_, i) => ({ id: `tool_${i}`, sessionID: id, type: "tool", tool: "read", state: { status: "completed" } })) }]
}
test("counts are exact only for a complete bounded child history and clocks are truthful", () => {
  assert.deepEqual(subtaskStats(childMessages(), true), task.stats)
  assert.deepEqual(subtaskStats(childMessages(), false), { toolCalls: 15, complete: false })
  for (const completed of [undefined, -1, 0.5, Infinity, 999]) {
    const messages = childMessages(); messages[1].info.time.completed = completed
    assert.deepEqual(subtaskStats(messages, true), { toolCalls: 15, complete: true })
  }
  assert.throws(() => subtaskStats([{ info: {}, parts: Array(5001).fill({ type: "tool" }) }], true))
})

async function adapterFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "chat-subtask-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const other = path.join(root, "other"); await mkdir(other)
  const parent = { id: "ses_parent", title: "Parent", directory: root, time: { updated: 1 } }
  const child = { ...parent, id: "ses_child", parentID: parent.id }
  const unrelated = { ...parent, id: "ses_unrelated" }
  const state = { parent, child, unrelated, parts: fixture.nativeParts, calls: [], status: {}, beforeReturn: () => {}, missing: false, partial: false }
  const ok = (data, headers = {}) => ({ data, response: new Response(null, { headers }) })
  const client = { session: {
    get: async ({ path: { id } }) => {
      const session = [parent, child, unrelated].find((s) => s.id === id)
      if (!session || state.missing && id === child.id) return { response: new Response(null, { status: 404 }) }
      return ok(session)
    },
    messages: async ({ path: { id }, query, signal, url }) => {
      if (url) return ok({ data: [], cursor: {} })
      state.calls.push([id, query]); signal.throwIfAborted()
      if (id === parent.id) return ok([{ info: { id: "msg_parent", role: "assistant", sessionID: id }, parts: state.parts }])
      state.beforeReturn()
      return ok(childMessages(), state.partial ? { "x-next-cursor": "earlier" } : {})
    },
    status: async () => ok(state.status),
    promptAsync: async () => { throw new Error("Must never mutate a child") },
    abort: async () => { throw new Error("Must never mutate a child") },
  } }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  return { adapter, state, other, body: { version: 1, projectId: projects[0].id, sessionId: parent.id, includeSubtasks: true } }
}

test("adapter enriches only verified child sessions and the explicit route is read-only", async (t) => {
  const { adapter, state, body } = await adapterFixture(t)
  const result = await adapter.execute("chat.snapshot", body)
  assert.deepEqual(result.messages[0].parts[1].task, task)
  assert.equal(state.calls[1][1].limit, 100)
  const childBody = { version: 1, projectId: body.projectId, sessionId: state.child.id, parentSessionId: state.parent.id }
  const child = await adapter.execute("chat.subtask.snapshot", childBody)
  assert.equal(child.chat.parentId, state.parent.id)
  const tools = await adapter.execute("chat.subtask.snapshot", { ...childBody, includeTools: true })
  assert.equal(tools.messages[1].parts.length, 15)
  assert.ok(tools.messages[1].parts.every((part) => part.type === "tool" && part.tool.operation === "read"))
  for (const operation of ["chat.snapshot", "chat.prompt", "chat.abort", "chat.get", "chat.rename", "chat.fork", "chat.delete"]) {
    await assert.rejects(adapter.execute(operation, { version: 1, projectId: body.projectId, sessionId: state.child.id,
      ...(operation === "chat.rename" ? { title: "title" } : {}),
      ...(operation === "chat.prompt" ? { text: "prompt" } : {}),
    }), { code: "access_denied" })
  }
  await assert.rejects(adapter.execute("chat.subtask.snapshot", { ...childBody, parentSessionId: state.unrelated.id }), { code: "access_denied" })
})

test("foreign, deleted and changing children omit all child IDs and stats without losing the parent", async (t) => {
  for (const mode of ["foreign", "unrelated", "deleted", "race"]) {
    const { adapter, state, body, other } = await adapterFixture(t)
    if (mode === "foreign") state.child.directory = other
    if (mode === "unrelated") state.child.parentID = state.unrelated.id
    if (mode === "deleted") state.missing = true
    if (mode === "race") state.beforeReturn = () => { state.child.directory = other }
    const result = await adapter.execute("chat.snapshot", body)
    const summary = result.messages[0].parts[1].task
    assert.equal(summary.sessionId, undefined)
    assert.equal(summary.stats, undefined)
    assert.ok(result.messages[0].text.includes("palette"))
    if (mode !== "race") assert.equal(state.calls.length, 1)
  }
})

test("running children omit finished durations and partial histories expose lower-bound counts", async (t) => {
  const { adapter, state, body } = await adapterFixture(t)
  state.partial = true
  let summary = (await adapter.execute("chat.snapshot", body)).messages[0].parts[1].task
  assert.deepEqual(summary.stats, { toolCalls: 15, complete: false })
  state.partial = false; state.status = { ses_child: { type: "busy" } }
  summary = (await adapter.execute("chat.snapshot", body)).messages[0].parts[1].task
  assert.equal(summary.status, "running")
  assert.equal(summary.stats.durationMs, undefined)
})

test("enrichment bounds child reads while preserving all task rows", async (t) => {
  const { adapter, state, body } = await adapterFixture(t)
  state.parts = Array.from({ length: 12 }, (_, i) => ({ ...fixture.nativeParts[1], id: `task_${i}` }))
  const result = await adapter.execute("chat.snapshot", body)
  assert.equal(state.calls.length, 9)
  assert.equal(result.messages[0].parts.length, 12)
  assert.equal(result.messages[0].parts.filter((p) => p.task.sessionId).length, 8)
})
