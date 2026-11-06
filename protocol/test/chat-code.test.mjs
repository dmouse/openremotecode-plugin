import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatStreamRequests, chatMessagePartSchema, chatResponses } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/chat-code-v1.json", import.meta.url), "utf8"))
const part = fixture.response.parts[0]
const request = { version: 1, projectId: "00000000-0000-4000-8000-000000000001", sessionId: "ses_code" }
const snapshot = () => ({ version: 1, chat: { id: "ses_code", title: "Code", updatedAt: 2000 },
  messages: [structuredClone(fixture.response)], status: "idle", cursor: null })

test("code details require tools opt-in for snapshots and streams, not an execution operation", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.code"))
  assert.equal(Object.hasOwn(chatRequests, "chat.code"), false)
  for (const [schema, target] of [
    [chatRequests["chat.snapshot"], request],
    [chatRequests["chat.subtask.snapshot"], { ...request, parentSessionId: "ses_parent" }],
    [chatStreamRequests["chat.stream.subscribe"], { ...request, subscriptionId: request.projectId }],
  ]) {
    schema.parse({ ...target, includeTools: true, includeCode: true })
    for (const extra of [{ includeCode: true }, { includeTools: false, includeCode: true },
      { includeTools: true, includeCode: "true" }]) {
      assert.equal(schema.safeParse({ ...target, ...extra }).success, false)
    }
  }
  chatResponses["chat.snapshot"].parse(snapshot())
})

test("code details are strict, execution-only and share message/truncation bounds", () => {
  for (const code of [null, {}, { ...part.tool.code, source: "c".repeat(8001) },
    { ...part.tool.code, output: "o".repeat(32001) }, { ...part.tool.code, truncated: null },
    { ...part.tool.code, metadata: {} }]) {
    assert.equal(chatMessagePartSchema.safeParse({ ...part, tool: { ...part.tool, code } }).success, false)
  }
  for (const extra of [{ operation: "read" }, { shell: { command: "", output: "", truncated: false } }]) {
    assert.equal(chatMessagePartSchema.safeParse({ ...part, tool: { ...part.tool, ...extra } }).success, false)
  }
  const response = snapshot()
  const message = response.messages[0]
  message.parts[0].tool.code = { source: "c".repeat(8000), output: "o".repeat(32000), truncated: false }
  message.parts.push({ id: "text", type: "text", text: "t".repeat(8000) })
  message.text += "t".repeat(8000)
  assert.equal(chatResponses["chat.snapshot"].safeParse(response).success, false)
  const shortened = snapshot()
  shortened.messages[0].parts[0].tool.code.truncated = true
  assert.equal(chatResponses["chat.snapshot"].safeParse(shortened).success, false)
  shortened.messages[0].truncated = true
  chatResponses["chat.snapshot"].parse(shortened)
})
