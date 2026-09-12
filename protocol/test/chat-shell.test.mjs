import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatResponses, chatMessagePartSchema } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/chat-shell-v1.json", import.meta.url), "utf8"))
const part = fixture.response.messages[1].parts[0]

test("shell details require explicit tool snapshot opt-in, never a callable operation", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.shell"))
  assert.equal(Object.hasOwn(chatRequests, "chat.shell"), false)
  for (const operation of ["chat.snapshot", "chat.subtask.snapshot"]) {
    const request = { version: 1, projectId: "00000000-0000-4000-8000-000000000001", sessionId: "ses_shell",
      ...(operation === "chat.subtask.snapshot" ? { parentSessionId: "ses_parent" } : {}) }
    chatRequests[operation].parse({ ...request, includeTools: true, includeShell: true })
    for (const extra of [{ includeShell: true }, { includeTools: false, includeShell: true },
      { includeTools: true, includeShell: "true" }]) {
      assert.equal(chatRequests[operation].safeParse({ ...request, ...extra }).success, false)
    }
    chatResponses[operation].parse(fixture.response)
  }
})

test("shell details are strict, execute-only, and share the message budget", () => {
  for (const shell of [null, {}, { ...part.tool.shell, command: "x".repeat(8001) },
    { ...part.tool.shell, output: "x".repeat(32001) }, { ...part.tool.shell, truncated: null },
    { ...part.tool.shell, input: {} }, { ...part.tool.shell, error: "private" }]) {
    assert.equal(chatMessagePartSchema.safeParse({ ...part, tool: { ...part.tool, shell } }).success, false)
  }
  assert.equal(chatMessagePartSchema.safeParse({ ...part, tool: { ...part.tool, operation: "read" } }).success, false)
  const response = structuredClone(fixture.response)
  const message = response.messages[1]
  message.parts[0].tool.shell = { command: "c".repeat(8000), output: "o".repeat(32000), truncated: false }
  message.parts.push({ id: "text", type: "text", text: "t".repeat(8000) })
  message.text += "t".repeat(8000)
  assert.equal(chatResponses["chat.snapshot"].safeParse(response).success, false)
  const shortened = structuredClone(fixture.response)
  shortened.messages[1].parts[0].tool.shell.truncated = true
  assert.equal(chatResponses["chat.snapshot"].safeParse(shortened).success, false)
  shortened.messages[1].truncated = true
  chatResponses["chat.snapshot"].parse(shortened)
})
