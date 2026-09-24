import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { chatMessageContent } from "../../dist/chat-message.js"
import { subtaskStats } from "../../dist/chat-subtask.js"

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
