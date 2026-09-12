import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatResponses } from "../dist/index.js"

const fixtures = JSON.parse(await readFile(new URL("./fixtures/chat-prompt-mode-v1.json", import.meta.url), "utf8"))

test("prompt mode fixtures accept only bounded modes and preserve text-only clients", () => {
  for (const request of fixtures.valid) {
    assert.deepEqual(chatRequests["chat.prompt"].parse(request), request)
    for (const key of ["version", "projectId", "sessionId", "text"]) {
      const missing = { ...request }; delete missing[key]
      assert.equal(chatRequests["chat.prompt"].safeParse(missing).success, false)
    }
  }
  for (const override of [...fixtures.invalidOverrides, { text: "x".repeat(32001) }]) {
    assert.equal(chatRequests["chat.prompt"].safeParse({ ...fixtures.valid[0], ...override }).success, false)
  }
  assert.deepEqual(chatResponses["chat.prompt"].parse({ version: 1, accepted: true }), { version: 1, accepted: true })
})

test("prompt mode is a capability marker, never an operation", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.prompt"))
  assert.ok(CHAT_CAPABILITIES.includes("chat.prompt.mode"))
  assert.equal(Object.hasOwn(chatRequests, "chat.prompt.mode"), false)
  assert.equal(Object.hasOwn(chatResponses, "chat.prompt.mode"), false)
})
