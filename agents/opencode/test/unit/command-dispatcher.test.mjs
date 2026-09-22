import assert from "node:assert/strict"
import test from "node:test"

import { CommandDispatcher } from "../../dist/command-dispatcher.js"
import {
  decryptRelayEnvelope,
  encryptRelayPayload,
  generateConnectorIdentity,
  sessionListResponseBodySchema,
} from "@openremotecode/protocol"

const NOW = 1_788_115_200_000
const TEST_EPOCH = "e".repeat(43)
let nextSequence = 0

test("session.list is dispatched and returned as an encrypted normalized response", async () => {
  const connector = await generateConnectorIdentity(NOW)
  const client = await generateConnectorIdentity(NOW)
  const sessions = [
    {
      id: "session-1",
      title: "First session",
      createdAt: NOW - 2_000,
      updatedAt: NOW - 1_000,
    },
  ]
  const dispatcher = createDispatcher(connector, client, {
    listSessions: async () => sessions,
  })
  const request = await createRequest(client, connector, "session.list", {})

  const response = await dispatcher.handle(request)
  assert.ok(response)
  const payload = await decryptRelayEnvelope({
    recipient: client.identity,
    sender: connector.identity.publicIdentity,
    envelope: response,
    epoch: TEST_EPOCH,
    now: NOW,
  })

  assert.equal(payload.kind, "response")
  assert.equal(payload.operation, "session.list")
  assert.deepEqual(sessionListResponseBodySchema.parse(payload.body), { sessions })
})

test("unsupported operations return an encrypted protocol error", async () => {
  const connector = await generateConnectorIdentity(NOW)
  const client = await generateConnectorIdentity(NOW)
  const dispatcher = createDispatcher(connector, client, {
    listSessions: async () => [],
  })
  const request = await createRequest(client, connector, "file.read", {})

  const response = await dispatcher.handle(request)
  assert.ok(response)
  const payload = await decryptRelayEnvelope({
    recipient: client.identity,
    sender: connector.identity.publicIdentity,
    envelope: response,
    epoch: TEST_EPOCH,
    now: NOW,
  })

  assert.equal(payload.operation, "protocol.error")
  assert.deepEqual(payload.body, {
    code: "unsupported_operation",
    message: "The requested operation is not supported",
  })
})

test("frames from an untrusted sender receive no response", async () => {
  const connector = await generateConnectorIdentity(NOW)
  const trustedClient = await generateConnectorIdentity(NOW)
  const untrustedClient = await generateConnectorIdentity(NOW)
  const dispatcher = createDispatcher(connector, trustedClient, {
    listSessions: async () => [],
  })
  const request = await createRequest(
    untrustedClient,
    connector,
    "session.list",
    {},
  )

  assert.equal(await dispatcher.handle(request), undefined)
})

test("OpenCode failures return a fixed encrypted error without internal details", async () => {
  const connector = await generateConnectorIdentity(NOW)
  const client = await generateConnectorIdentity(NOW)
  const dispatcher = createDispatcher(connector, client, {
    listSessions: async () => {
      throw new Error("sensitive local failure")
    },
  })
  const request = await createRequest(client, connector, "session.list", {})

  const response = await dispatcher.handle(request)
  assert.ok(response)
  assert.equal(JSON.stringify(response).includes("sensitive local failure"), false)
  const payload = await decryptRelayEnvelope({
    recipient: client.identity,
    sender: connector.identity.publicIdentity,
    envelope: response,
    epoch: TEST_EPOCH,
    now: NOW,
  })
  assert.deepEqual(payload.body, {
    code: "opencode_error",
    message: "OpenCode could not list sessions",
  })
})

function createDispatcher(connector, client, sessions) {
  const dispatcher = new CommandDispatcher({
    connectorIdentity: connector.identity,
    trustedClient: client.identity.publicIdentity,
    sessions,
    now: () => NOW,
  })
  dispatcher.setEpoch(TEST_EPOCH)
  return dispatcher
}

async function createRequest(client, connector, operation, body) {
  return encryptRelayPayload({
    sender: client.identity,
    recipient: connector.identity.publicIdentity,
    payload: {
      protocolVersion: 2,
      kind: "request",
      requestId: crypto.randomUUID(),
      sentAt: NOW,
      operation,
      body,
    },
    epoch: TEST_EPOCH,
    sequence: nextSequence++,
    now: NOW,
  })
}

test("a chat adapter advertises its own capabilities and unsupported operations fail explicitly", async () => {
  const { ChatUnsupportedError } = await import("../../dist/chat-adapter.js")
  const connector = await generateConnectorIdentity(NOW)
  const client = await generateConnectorIdentity(NOW)
  const chats = { capabilities: ["chat.list"], execute: async (operation) => { throw new ChatUnsupportedError(operation) } }
  const dispatcher = new CommandDispatcher({
    connectorIdentity: connector.identity,
    trustedClient: client.identity.publicIdentity,
    sessions: { listSessions: async () => [] },
    chats,
    now: () => NOW,
  })
  dispatcher.setEpoch(TEST_EPOCH)
  assert.ok(dispatcher.capabilities.includes("chat.list"))
  assert.equal(dispatcher.capabilities.includes("chat.snapshot"), false)
  const response = await dispatcher.handle(await createRequest(client, connector, "chat.models",
    { version: 1, projectId: crypto.randomUUID() }))
  assert.ok(response)
  const payload = await decryptRelayEnvelope({ recipient: client.identity, sender: connector.identity.publicIdentity,
    envelope: response, epoch: TEST_EPOCH, now: NOW })
  assert.equal(payload.body.code, "unsupported_operation")
})
