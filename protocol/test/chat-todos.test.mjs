import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatResponses, chatStreamRequests, chatTodoSchema } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/chat-todos-v1.json", import.meta.url), "utf8"))
const todos = fixture.response.todos

test("todos are opt-in presentation, independent of every other opt-in, never a callable operation", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.todos"))
  assert.equal(Object.hasOwn(chatRequests, "chat.todos"), false)
  for (const operation of ["chat.snapshot", "chat.subtask.snapshot"]) {
    const request = { version: 1, projectId: "00000000-0000-4000-8000-000000000001", sessionId: "ses_todos",
      ...(operation === "chat.subtask.snapshot" ? { parentSessionId: "ses_parent" } : {}) }
    chatRequests[operation].parse({ ...request, includeTodos: true })
    // No dependency on tools/shell/images: a todo is not a message part.
    chatRequests[operation].parse({ ...request, includeTodos: true, includeTools: false })
    assert.equal(chatRequests[operation].safeParse({ ...request, includeTodos: "true" }).success, false)
    chatResponses[operation].parse(fixture.response)
  }
  chatStreamRequests["chat.stream.subscribe"].parse({ version: 1, projectId: "00000000-0000-4000-8000-000000000001",
    sessionId: "ses_todos", subscriptionId: "00000000-0000-4000-8000-000000000002", includeTodos: true })
  // Absent by default: an older/non-opted-in client never sees the field.
  const { todos: _dropped, ...withoutTodos } = fixture.response
  chatResponses["chat.snapshot"].parse(withoutTodos)
  // Opted in with nothing to show is an empty list, not null.
  chatResponses["chat.snapshot"].parse({ ...fixture.response, todos: [] })
  assert.equal(chatResponses["chat.snapshot"].safeParse({ ...fixture.response, todos: null }).success, false)
})

test("todo fields are strict and bounded, and never carry raw native fields", () => {
  for (const todo of todos) assert.equal(chatTodoSchema.safeParse(todo).success, true)
  for (const invalid of [
    { ...todos[0], status: "queued" },
    { ...todos[0], status: "" },
    { ...todos[0], content: "" },
    { ...todos[0], content: "c".repeat(257) },
    { ...todos[0], id: "" },
    { ...todos[0], priority: "high" },
    { ...todos[0], extra: "unexpected" },
  ]) {
    assert.equal(chatTodoSchema.safeParse(invalid).success, false)
  }
  assert.equal(JSON.stringify(todos).includes("PRIVATE_"), false)
  assert.equal(JSON.stringify(todos).includes("priority"), false)
})

test("a list is length-capped and its ids are unique", () => {
  const list = (length) => Array.from({ length }, (_, index) => ({ id: `tod_${index}`, content: "Task", status: "pending" }))
  const snapshot = (value) => chatResponses["chat.snapshot"].safeParse({ ...fixture.response, todos: value }).success
  assert.equal(snapshot(list(100)), true)
  assert.equal(snapshot(list(101)), false)
  assert.equal(snapshot([todos[0], { ...todos[1], id: todos[0].id }]), false)
})

test("the fixture's native list is what the plugin must project from", () => {
  // The pinned binary sends no id at all; the projection's ids are positional.
  assert.equal(fixture.nativeTodos.some((todo) => Object.hasOwn(todo, "id")), false)
  assert.deepEqual(todos.map((todo) => todo.id), fixture.nativeTodos.map((_, index) => `todo-${index}`))
  // The bidi override in the native text is gone from the projection.
  assert.ok(fixture.nativeTodos.some((todo) => /[‪-‮]/u.test(todo.content)))
  assert.equal(todos.some((todo) => /[‪-‮]/u.test(todo.content)), false)
  // An unrecognized native status is presented as pending, not forwarded.
  const unknown = fixture.nativeTodos.findIndex((todo) => todo.status === "queued")
  assert.ok(unknown >= 0)
  assert.equal(todos[unknown].status, "pending")
})
