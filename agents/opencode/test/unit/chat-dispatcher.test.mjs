import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { decryptRelayEnvelope, encryptRelayPayload, generateConnectorIdentity } from "@openremotecode/protocol"
import { CommandDispatcher } from "../../dist/command-dispatcher.js"
import { ChatAccessError } from "../../dist/chat-adapter.js"

const mutationFixtures = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-mutations-v1.json", import.meta.url), "utf8"))
const promptFixtures = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-prompt-mode-v1.json", import.meta.url), "utf8"))

const TEST_EPOCH = "e".repeat(43)

async function fixture(execute) {
  const connector = await generateConnectorIdentity()
  const client = await generateConnectorIdentity()
  const dispatcher = new CommandDispatcher({ connectorIdentity: connector.identity,
    trustedClient: client.identity.publicIdentity, sessions: { listSessions: async () => [] }, chats: { execute } })
  dispatcher.setEpoch(TEST_EPOCH)
  let sequence = 0
  return {
    dispatcher,
    async request(operation, body, requestId = crypto.randomUUID()) {
      return encryptRelayPayload({ sender: client.identity, recipient: connector.identity.publicIdentity,
        payload: { protocolVersion: 2, kind: "request", requestId, sentAt: Date.now(), operation, body },
        epoch: TEST_EPOCH, sequence: sequence++ })
    },
    async decode(envelope) { return decryptRelayEnvelope({ recipient: client.identity,
      sender: connector.identity.publicIdentity, envelope, epoch: TEST_EPOCH }) },
  }
}

test("encrypted create is executed once despite concurrent request-ID reuse; exact frames are rejected", async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; return { version: 1, chat: { id: "ses_fixture", title: "", updatedAt: 1 } } })
  const id = crypto.randomUUID()
  const body = { version: 1, projectId: crypto.randomUUID() }
  const first = await f.request("chat.create", body, id)
  const retry = await f.request("chat.create", body, id)
  const replies = await Promise.all([f.dispatcher.handle(first), f.dispatcher.handle(retry)])
  assert.equal(calls, 1)
  assert.equal((await f.decode(replies[0])).body.chat.id, "ses_fixture")
  assert.deepEqual(replies[0], replies[1])
  assert.equal(await f.dispatcher.handle(first), undefined)
  assert.equal(await f.dispatcher.handle(await f.request("chat.create", { ...body, projectId: crypto.randomUUID() }, id)), undefined)
  assert.equal(calls, 1)
})

test("unsupported versions, injected SDK arguments, and arbitrary operations never reach the adapter", async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; throw new Error("unexpected") })
  for (const [operation, body] of [
    ["project.list", { version: 2 }], ["project.list", { version: 1, directory: "/secret" }],
    ["chat.create", { version: 1, projectId: crypto.randomUUID(), permission: "allow" }],
    ["file.read", { version: 1 }], ["chat.prompt", { version: 1, projectId: crypto.randomUUID(), sessionId: "ses_fixture", text: "" }],
    ["chat.delete", { version: 1, projectId: crypto.randomUUID(), sessionId: "ses_fixture", recursive: true }],
    ["chat.delete", { version: 2, projectId: crypto.randomUUID(), sessionId: "ses_fixture" }],
  ]) {
    const response = await f.decode(await f.dispatcher.handle(await f.request(operation, body)))
    assert.equal(response.operation, "protocol.error")
  }
  assert.equal(calls, 0)
})

test("encrypted delete is journaled and failures have a fixed uncertain outcome", async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; return { version: 1, deleted: true } })
  const body = { version: 1, projectId: crypto.randomUUID(), sessionId: "ses_fixture" }
  const id = crypto.randomUUID()
  const first = await f.dispatcher.handle(await f.request("chat.delete", body, id))
  const retry = await f.dispatcher.handle(await f.request("chat.delete", body, id))
  assert.deepEqual((await f.decode(first)).body, { version: 1, deleted: true })
  assert.deepEqual(first, retry)
  assert.equal(calls, 1)
  const failing = await fixture(async () => { throw new Error("private path") })
  const response = await failing.decode(await failing.dispatcher.handle(await failing.request("chat.delete", body)))
  assert.equal(response.body.code, "uncertain_outcome")
  assert.equal(JSON.stringify(response).includes("private path"), false)
})

test("access denial and uncertain mutation failures expose only fixed encrypted errors", async () => {
  for (const [failure, code] of [[new ChatAccessError("access_denied"), "access_denied"],
    [new Error("sensitive provider error"), "uncertain_outcome"]]) {
    const f = await fixture(async () => { throw failure })
    const envelope = await f.dispatcher.handle(await f.request("chat.create", { version: 1, projectId: crypto.randomUUID() }))
    assert.equal(JSON.stringify(envelope).includes("sensitive"), false)
    const response = await f.decode(envelope)
    assert.equal(response.body.code, code)
    assert.equal(response.body.message.includes("sensitive"), false)
  }
})

test("shared rename/fork fixtures validate before encrypted dispatch and advertise only when enabled", async () => {
  for (const { operation, request, parsedRequest, response } of mutationFixtures.valid) {
    let calls = 0
    const f = await fixture(async (actualOperation, actualBody) => {
      calls++
      assert.equal(actualOperation, operation)
      assert.deepEqual(actualBody, parsedRequest)
      return response
    })
    assert.ok(f.dispatcher.capabilities.includes(operation))
    const reply = await f.decode(await f.dispatcher.handle(await f.request(operation, request)))
    assert.deepEqual(reply.body, response)
    assert.equal(reply.operation, operation)
    assert.equal(calls, 1)
  }
  const connector = await generateConnectorIdentity(), client = await generateConnectorIdentity()
  const disabled = new CommandDispatcher({ connectorIdentity: connector.identity,
    trustedClient: client.identity.publicIdentity, sessions: { listSessions: async () => [] } })
  assert.equal(disabled.capabilities.includes("chat.rename"), false)
  assert.equal(disabled.capabilities.includes("chat.fork"), false)
  assert.equal(disabled.capabilities.includes("chat.prompt.mode"), false)
  let calls = 0
  const f = await fixture(async () => { calls++; throw new Error("Invalid requests must not dispatch") })
  for (const { operation, request } of mutationFixtures.invalid) {
    const response = await f.decode(await f.dispatcher.handle(await f.request(operation, request)))
    assert.equal(response.body.code, "invalid_request")
  }
  assert.equal(calls, 0)
})

for (const { operation, request, response } of mutationFixtures.valid) {
  test(`${operation} journals concurrent and completed mutations and rejects changed payload reuse`, async () => {
    let calls = 0, release
    const gate = new Promise((resolve) => { release = resolve })
    const f = await fixture(async () => { calls++; await gate; return response })
    const id = crypto.randomUUID()
    const first = await f.request(operation, request, id)
    const retry = await f.request(operation, request, id)
    const pending = Promise.all([f.dispatcher.handle(first), f.dispatcher.handle(retry)])
    release()
    const replies = await pending
    assert.equal(calls, 1)
    assert.deepEqual(replies[0], replies[1])
    assert.deepEqual((await f.decode(replies[0])).body, response)
    assert.deepEqual(await f.dispatcher.handle(await f.request(operation, request, id)), replies[0])
    assert.equal(await f.dispatcher.handle(first), undefined)
    assert.equal(await f.dispatcher.handle(await f.request(operation, { ...request, sessionId: "ses_other" }, id)), undefined)
    assert.equal(await f.dispatcher.handle(await f.request(operation === "chat.rename" ? "chat.fork" : "chat.rename", request, id)), undefined)
    assert.equal(calls, 1)
  })

  test(`${operation} journals timeout, SDK and invalid response failures as fixed uncertain outcomes`, async () => {
    for (const failure of [new DOMException("private deadline", "TimeoutError"), new Error("private SDK error"), null]) {
      let calls = 0
      const f = await fixture(async () => { calls++; if (failure) throw failure; return { version: 1, accepted: true } })
      const id = crypto.randomUUID()
      const first = await f.dispatcher.handle(await f.request(operation, request, id))
      const retry = await f.dispatcher.handle(await f.request(operation, request, id))
      assert.deepEqual(first, retry)
      assert.equal(calls, 1)
      assert.deepEqual((await f.decode(first)).body, { code: "uncertain_outcome", message: "OpenCode could not complete the request" })
      assert.equal(JSON.stringify(await f.decode(first)).includes("private"), false)
    }
  })

  test(`${operation} preserves definitive authorization/busy failures without leaking native details`, async () => {
    for (const code of ["access_denied", "context_expired", "chat_not_found", "chat_busy"]) {
      const f = await fixture(async () => { throw new ChatAccessError(code) })
      const response = await f.decode(await f.dispatcher.handle(await f.request(operation, request)))
      assert.deepEqual(response.body, { code, message: "OpenCode could not complete the request" })
    }
  })
}

test("encrypted prompt fixtures preserve modes and reject invalid input and callable markers", async () => {
  const calls = []
  const f = await fixture(async (operation, body) => {
    calls.push({ operation, body })
    return { version: 1, accepted: true }
  })
  assert.ok(f.dispatcher.capabilities.includes("chat.prompt.mode"))
  for (const body of promptFixtures.valid) {
    const response = await f.decode(await f.dispatcher.handle(await f.request("chat.prompt", body)))
    assert.equal(response.operation, "chat.prompt")
    assert.deepEqual(response.body, { version: 1, accepted: true })
    assert.deepEqual(calls.at(-1), { operation: "chat.prompt", body })
  }
  for (const override of promptFixtures.invalidOverrides) {
    const response = await f.decode(await f.dispatcher.handle(await f.request("chat.prompt", { ...promptFixtures.valid[0], ...override })))
    assert.deepEqual(response.body, { code: "invalid_request", message: "The request body is invalid" })
  }
  const marker = await f.decode(await f.dispatcher.handle(await f.request("chat.prompt.mode", { version: 1 })))
  assert.equal(marker.body.code, "unsupported_operation")
  assert.equal(calls.length, 3)
})

test("encrypted prompts deduplicate concurrent retries and reject changed mode under the same ID", async () => {
  let calls = 0, release
  const gate = new Promise((resolve) => { release = resolve })
  const f = await fixture(async () => { calls++; await gate; return { version: 1, accepted: true } })
  const id = crypto.randomUUID(), body = promptFixtures.valid[1]
  const first = await f.request("chat.prompt", body, id)
  const retry = await f.request("chat.prompt", body, id)
  const pending = Promise.all([f.dispatcher.handle(first), f.dispatcher.handle(retry)])
  release()
  const replies = await pending
  assert.deepEqual(replies[0], replies[1])
  assert.deepEqual(await f.dispatcher.handle(await f.request("chat.prompt", body, id)), replies[0])
  assert.equal(await f.dispatcher.handle(first), undefined)
  assert.equal(await f.dispatcher.handle(await f.request("chat.prompt", { ...body, mode: "plan" }, id)), undefined)
  assert.equal(await f.dispatcher.handle(await f.request("chat.prompt", promptFixtures.valid[0], id)), undefined)
  assert.equal(calls, 1)
})

test("prompt SDK failures and deadlines are encrypted, fixed and journaled without retry", async () => {
  for (const failure of [new Error("private SDK detail"), new DOMException("private deadline", "TimeoutError")]) {
    let calls = 0
    const f = await fixture(async () => { calls++; throw failure })
    const id = crypto.randomUUID(), body = promptFixtures.valid[2]
    const first = await f.dispatcher.handle(await f.request("chat.prompt", body, id))
    assert.deepEqual(await f.dispatcher.handle(await f.request("chat.prompt", body, id)), first)
    assert.deepEqual((await f.decode(first)).body, { code: "uncertain_outcome", message: "OpenCode could not complete the request" })
    assert.equal(JSON.stringify(first).includes(body.text), false)
    assert.equal(calls, 1)
  }
})
