import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatResponses, chatMessagePartSchema } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/chat-tools-v1.json", import.meta.url), "utf8"))

test("tools are opt-in snapshot presentation, not a callable operation", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.tools"))
  assert.equal(Object.hasOwn(chatRequests, "chat.tools"), false)
  for (const operation of ["chat.snapshot", "chat.subtask.snapshot"]) {
    const request = { version: 1, projectId: "00000000-0000-4000-8000-000000000001", sessionId: "ses_fixture",
      ...(operation === "chat.subtask.snapshot" ? { parentSessionId: "ses_parent" } : {}) }
    chatRequests[operation].parse(request)
    chatRequests[operation].parse({ ...request, includeTools: true })
    assert.equal(chatRequests[operation].safeParse({ ...request, includeTools: "true" }).success, false)
    chatResponses[operation].parse(fixture.response)
  }
  chatResponses["chat.snapshot"].parse({ ...fixture.response, messages: [fixture.userResponse] })
})

test("tool fields, durations and display budgets remain strict", () => {
  const part = fixture.response.messages[0].parts[0]
  for (const extra of [
    { operation: "arbitrary_sdk" }, { status: "success" }, { description: "" },
    { description: "x".repeat(257) }, { description: null }, { durationMs: -1 },
    { durationMs: 0.5 }, { durationMs: 9007199254740992 }, { durationMs: null },
    { input: {} }, { output: "private" }, { command: "private" }, { error: "private" },
  ]) assert.equal(chatMessagePartSchema.safeParse({ ...part, tool: { ...part.tool, ...extra } }).success, false)
  assert.equal(chatMessagePartSchema.safeParse({ ...part, metadata: {} }).success, false)
})

test("a completed question tool call's asked/answered summary is a bounded description, no shell", () => {
  const part = fixture.response.messages[0].parts[0]
  const questionTool = { ...part.tool, operation: "question", description: "Environment: Local · Platform: Android" }
  assert.equal(chatMessagePartSchema.safeParse({ ...part, tool: questionTool }).success, true)
  // A "question" operation may not carry a shell sub-object, same as any non-execute operation.
  assert.equal(
    chatMessagePartSchema.safeParse({ ...part, tool: { ...questionTool,
      shell: { command: "", output: "", truncated: false } } }).success,
    false,
  )
})
