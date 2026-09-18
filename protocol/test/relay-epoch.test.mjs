import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  decryptRelayEnvelope,
  deriveRelayEpoch,
  encryptRelayPayload,
  generateConnectorIdentity,
  generateRelayNonce,
  ReplayWindow,
} from "../dist/index.js"

const NOW = 1_788_115_200_000
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/relay-epoch-v2.json", import.meta.url), "utf8"),
)

test("epoch derivation matches the shared cross-language fixture", async () => {
  // The Dart client derives epochs from the same fixture; if either side drifts
  // the two peers silently stop agreeing on what connection they are in.
  for (const expected of fixture.cases) {
    assert.equal(await deriveRelayEpoch(expected), expected.epoch)
  }
})

test("both peers derive the same epoch, and any fresh nonce changes it", async () => {
  const peers = {
    connectorKeyId: "c".repeat(43),
    connectorNonce: generateRelayNonce(),
    clientKeyId: "b".repeat(43),
    clientNonce: generateRelayNonce(),
  }

  const onConnector = await deriveRelayEpoch(peers)
  const onClient = await deriveRelayEpoch(peers)
  assert.equal(onConnector, onClient, "Both sides derive the epoch from the same role-ordered transcript")
  assert.match(onConnector, /^[A-Za-z0-9_-]{43}$/u)

  // Neither peer alone, and so neither a relay nor a replayed connection, can pin the epoch.
  for (const field of ["connectorNonce", "clientNonce"]) {
    const reconnected = await deriveRelayEpoch({ ...peers, [field]: generateRelayNonce() })
    assert.notEqual(reconnected, onConnector)
  }
  // The transcript is role-ordered, so swapping the roles is a different connection.
  assert.notEqual(
    await deriveRelayEpoch({
      connectorKeyId: peers.clientKeyId,
      connectorNonce: peers.clientNonce,
      clientKeyId: peers.connectorKeyId,
      clientNonce: peers.connectorNonce,
    }),
    onConnector,
  )
})

test("nonces are fresh and the derivation rejects malformed ones", async () => {
  const nonces = new Set(Array.from({ length: 64 }, () => generateRelayNonce()))
  assert.equal(nonces.size, 64)
  for (const nonce of nonces) assert.match(nonce, /^[A-Za-z0-9_-]{22}$/u)

  await assert.rejects(
    deriveRelayEpoch({
      connectorKeyId: "c".repeat(43),
      connectorNonce: "short",
      clientKeyId: "b".repeat(43),
      clientNonce: generateRelayNonce(),
    }),
  )
})

test("an envelope sealed in one epoch is rejected in the next", async () => {
  const connector = await generateConnectorIdentity(NOW)
  const client = await generateConnectorIdentity(NOW)
  const epoch = await deriveRelayEpoch({
    connectorKeyId: connector.identity.publicIdentity.keyId,
    connectorNonce: generateRelayNonce(),
    clientKeyId: client.identity.publicIdentity.keyId,
    clientNonce: generateRelayNonce(),
  })
  const envelope = await encryptRelayPayload({
    sender: client.identity,
    recipient: connector.identity.publicIdentity,
    payload: {
      protocolVersion: 2,
      kind: "request",
      requestId: crypto.randomUUID(),
      sentAt: NOW,
      operation: "session.list",
      body: {},
    },
    epoch,
    sequence: 0,
    now: NOW,
  })

  const opened = await decryptRelayEnvelope({
    recipient: connector.identity,
    sender: client.identity.publicIdentity,
    envelope,
    epoch,
    now: NOW,
  })
  assert.equal(opened.operation, "session.list")

  // The connector restarted: the envelope is still inside its TTL, but its epoch is over.
  const reconnected = await deriveRelayEpoch({
    connectorKeyId: connector.identity.publicIdentity.keyId,
    connectorNonce: generateRelayNonce(),
    clientKeyId: client.identity.publicIdentity.keyId,
    clientNonce: generateRelayNonce(),
  })
  await assert.rejects(
    decryptRelayEnvelope({
      recipient: connector.identity,
      sender: client.identity.publicIdentity,
      envelope,
      epoch: reconnected,
      now: NOW,
    }),
    /different connection epoch/u,
  )
  // The epoch is authenticated, so relabelling the envelope cannot rescue it either.
  await assert.rejects(
    decryptRelayEnvelope({
      recipient: connector.identity,
      sender: client.identity.publicIdentity,
      envelope: { ...envelope, epoch: reconnected },
      epoch: reconnected,
      now: NOW,
    }),
  )
})

test("the replay window accepts progress and reordering but never the same sequence twice", () => {
  const window = new ReplayWindow(64)

  assert.equal(window.accept(0), true)
  assert.equal(window.accept(0), false, "An exact replay is rejected")
  assert.equal(window.accept(1), true)
  assert.equal(window.highest, 1)

  // Envelopes seal concurrently, so they can arrive out of order inside the window.
  assert.equal(window.accept(5), true)
  assert.equal(window.accept(3), true)
  assert.equal(window.accept(4), true)
  assert.equal(window.accept(3), false)
  assert.equal(window.accept(5), false)
  assert.equal(window.highest, 5)

  // Anything older than the window is refused rather than silently re-accepted.
  assert.equal(window.accept(200), true)
  assert.equal(window.accept(5), false)
  assert.equal(window.accept(136), false, "200 - 64 is outside the window")
  assert.equal(window.accept(137), true)

  // A jump past the window width clears it without stranding later sequences.
  assert.equal(window.accept(10_000), true)
  assert.equal(window.accept(9_999), true)
  assert.equal(window.accept(9_999), false)

  for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(window.accept(invalid), false)
  }
})

test("a fresh window shares no state with the one before it", () => {
  const first = new ReplayWindow(32)
  assert.equal(first.accept(9), true)
  assert.equal(first.accept(9), false)

  // Sequences restart per epoch, so a new window must accept them again.
  const second = new ReplayWindow(32)
  assert.equal(second.accept(9), true)
  assert.equal(second.accept(0), true)
  assert.equal(second.highest, 9)

  assert.throws(() => new ReplayWindow(0))
  assert.throws(() => new ReplayWindow(33))
})
