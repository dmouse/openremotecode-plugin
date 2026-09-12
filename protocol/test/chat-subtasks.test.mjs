import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatResponses } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/chat-subtasks-v1.json", import.meta.url), "utf8"))
const message = fixture.response.messages[0]
const part = message.parts[1]
const valid = (task) => chatResponses["chat.snapshot"].safeParse({ ...fixture.response,
  messages: [{ ...message, parts: [message.parts[0], { ...part, task }, message.parts[2]] }] }).success

test("subtasks use an explicit read capability and preserve the fallback contract", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.subtask.snapshot"))
  assert.deepEqual(chatRequests["chat.subtask.snapshot"].parse(fixture.request), fixture.request)
  assert.deepEqual(chatResponses["chat.snapshot"].parse(fixture.response), fixture.response)
  for (const extra of [{ version: 2 }, { method: "shell" }, { path: "/other" }, { parentSessionId: "" }, { sessionId: "x".repeat(129) }]) {
    assert.equal(chatRequests["chat.subtask.snapshot"].safeParse({ ...fixture.request, ...extra }).success, false)
  }
  const { parentSessionId: _parentSessionId, ...missing } = fixture.request
  assert.equal(chatRequests["chat.subtask.snapshot"].safeParse(missing).success, false)
})

test("subtask presentation rejects raw metadata, unsupported states and malformed counts", () => {
  for (const extra of [{ title: "" }, { title: "x".repeat(513) }, { agent: "x".repeat(65) },
    { metadata: {} }, { input: {} }, { output: "secret" }, { status: "aborted" }, { background: 1 },
    { sessionId: null }, { stats: null },
    ...[{ toolCalls: -1 }, { toolCalls: 1.5 }, { toolCalls: 5001 }, { complete: null },
      { durationMs: -1 }, { durationMs: 9007199254740992 }, { metadata: {} }]
      .map((stats) => ({ stats: { ...part.task.stats, ...stats } })),
  ]) assert.equal(valid({ ...part.task, ...extra }), false)
  const { sessionId: _sessionId, stats: _stats, ...unavailable } = part.task
  assert.equal(valid(unavailable), true)
})
