import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatResponses } from "../dist/index.js"

const fixtures = JSON.parse(await readFile(new URL("./fixtures/chat-mutations-v1.json", import.meta.url), "utf8"))

test("versioned rename/fork fixtures preserve the existing chat-summary convention", () => {
  for (const { operation, request, parsedRequest, response } of fixtures.valid) {
    assert.ok(CHAT_CAPABILITIES.includes(operation))
    assert.deepEqual(chatRequests[operation].parse(request), parsedRequest)
    assert.deepEqual(chatResponses[operation].parse(response), response)
    for (const key of Object.keys(request)) {
      const missing = { ...request }; delete missing[key]
      assert.equal(chatRequests[operation].safeParse(missing).success, false)
    }
    for (const extra of ["directory", "path", "url", "method", "parentID", "messageId", "messageID", "permission"]) {
      assert.equal(chatRequests[operation].safeParse({ ...request, [extra]: "injected" }).success, false)
    }
    for (const invalid of [{ ...response, version: 2 }, { ...response, accepted: true },
      { version: 1, session: response.chat }, { ...response, chat: { ...response.chat, directory: "/private" } }]) {
      assert.equal(chatResponses[operation].safeParse(invalid).success, false)
    }
  }
  for (const { operation, request } of fixtures.invalid) {
    assert.equal(chatRequests[operation].safeParse(request).success, false)
  }
})

test("rename trims before applying nonempty and 512 UTF-16 code-unit limits", () => {
  const request = fixtures.valid[0].request
  for (const title of ["", " \t\r\n ", "x".repeat(513), null, 42]) {
    assert.equal(chatRequests["chat.rename"].safeParse({ ...request, title }).success, false)
  }
  const title = "x".repeat(512)
  assert.equal(chatRequests["chat.rename"].parse({ ...request, title: ` ${title} ` }).title, title)
})
