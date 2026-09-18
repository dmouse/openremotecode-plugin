import assert from "node:assert/strict"
import test from "node:test"

import { maintainConnectorCredential } from "../../dist/auth/credential-renewal.js"

const NOW = 1_788_115_200_000
const DAY = 24 * 60 * 60 * 1000
const CURRENT = `orc_${"A".repeat(43)}`
const ISSUED = `orc_${"N".repeat(43)}`

function authorization(overrides = {}) {
  return {
    version: 2,
    serviceOrigin: "https://api.example.test",
    connectorId: `con_${"c".repeat(24)}`,
    connectorKeyId: "k".repeat(43),
    credential: CURRENT,
    credentialExpiresAt: new Date(NOW + 90 * DAY).toISOString(),
    trustedClient: { version: 1, suite: "HPKE-Auth-P256-HKDF-SHA256-AES-256-GCM", keyId: "t".repeat(43), publicKey: "AQ" },
    ...overrides,
  }
}

function store(initial) {
  const state = { value: initial, writes: [] }
  return {
    state,
    async load() { return state.value },
    async replace(value) {
      state.value = value
      state.writes.push(value)
    },
    async clear() { state.value = undefined },
  }
}

function api(behavior = {}) {
  const calls = []
  return {
    calls,
    async rotateConnectorCredential(credential) {
      calls.push(["rotate", credential])
      if (behavior.rotateError) throw behavior.rotateError
      return { credential: ISSUED, activateBy: new Date(NOW + 15 * 60_000).toISOString() }
    },
    async activateConnectorCredential(credential) {
      calls.push(["activate", credential])
      if (behavior.activateError) throw behavior.activateError
      return { credentialExpiresAt: new Date(NOW + 90 * DAY).toISOString() }
    },
  }
}

test("a credential outside its final third is left alone", async () => {
  const current = authorization()
  const state = store(current)
  const client = api()

  const { authorization: result, outcome } = await maintainConnectorCredential({
    store: state, api: client, authorization: current, now: () => NOW,
  })


  assert.deepEqual(client.calls, [], "renewal ran too early")
  assert.equal(result.credential, CURRENT)
  assert.deepEqual(state.state.writes, [])
  assert.equal(outcome, "unchanged", "the reported outcome is what the client renders")
})

test("renewal persists the replacement before activating it", async () => {
  const current = authorization({ credentialExpiresAt: new Date(NOW + 20 * DAY).toISOString() })
  const state = store(current)
  const client = api()

  const { authorization: result, outcome } = await maintainConnectorCredential({
    store: state, api: client, authorization: current, now: () => NOW,
  })


  assert.deepEqual(client.calls, [["rotate", CURRENT], ["activate", ISSUED]])
  // The staged write must land before activation, or a crash in between loses the credential
  // the server is about to commit.
  assert.equal(state.state.writes.length, 2)
  assert.equal(state.state.writes[0].pending.credential, ISSUED)
  assert.equal(state.state.writes[0].credential, CURRENT, "the live credential changed before activation")
  assert.equal(state.state.writes[1].credential, ISSUED)
  assert.equal(state.state.writes[1].pending, undefined)
  assert.equal(result.credential, ISSUED)
  assert.equal(result.version, 2)
  assert.equal(outcome, "renewed", "the reported outcome is what the client renders")
})

test("a crash between persisting and activating is resolved on the next start", async () => {
  // The previous run wrote the pending credential and then died.
  const staged = authorization({
    credentialExpiresAt: new Date(NOW + 20 * DAY).toISOString(),
    pending: { credential: ISSUED, activateBy: new Date(NOW + 10 * 60_000).toISOString() },
  })

  const state = store(staged)
  const client = api()

  const { authorization: result, outcome } = await maintainConnectorCredential({
    store: state, api: client, authorization: staged, now: () => NOW,
  })

  // Pending is tried first, because a rotation committed just before the crash leaves it as
  // the only working credential.
  assert.deepEqual(client.calls[0], ["activate", ISSUED])
  assert.equal(result.credential, ISSUED)
  assert.equal(result.pending, undefined)
  assert.equal(outcome, "renewed", "the reported outcome is what the client renders")
})

test("an unactivated rotation whose deadline has not passed is kept, not discarded", async () => {
  const staged = authorization({
    pending: { credential: ISSUED, activateBy: new Date(NOW + 5 * 60_000).toISOString() },
  })

  const state = store(staged)
  const client = api({ activateError: new Error("network unreachable") })

  const { authorization: result, outcome } = await maintainConnectorCredential({
    store: state, api: client, authorization: staged, now: () => NOW,
  })

  // The failure is ambiguous: the server may already have committed this credential, so
  // discarding it here is what would cause a lockout.
  assert.equal(result.pending?.credential, ISSUED)
  assert.equal(result.credential, CURRENT)
  assert.deepEqual(state.state.writes, [], "an ambiguous failure rewrote the file")
  assert.equal(outcome, "unchanged", "the reported outcome is what the client renders")
})

test("a pending credential is discarded once its own deadline has provably passed", async () => {
  const staged = authorization({
    pending: { credential: ISSUED, activateBy: new Date(NOW - 1000).toISOString() },
  })

  const state = store(staged)
  const client = api({ activateError: new Error("unauthorized") })

  const { authorization: result, outcome } = await maintainConnectorCredential({
    store: state, api: client, authorization: staged, now: () => NOW,
  })

  assert.equal(result.pending, undefined)
  assert.equal(result.credential, CURRENT, "discarding a lapsed rotation disturbed the live credential")
  assert.equal(state.state.writes.at(-1).pending, undefined)
  assert.equal(outcome, "unchanged", "the reported outcome is what the client renders")
})

test("a failed rotation leaves a usable credential and no half-written state", async () => {
  const current = authorization({ credentialExpiresAt: new Date(NOW + 20 * DAY).toISOString() })
  const state = store(current)
  const client = api({ rotateError: new Error("service unavailable") })

  const { authorization: result, outcome } = await maintainConnectorCredential({
    store: state, api: client, authorization: current, now: () => NOW,
  })


  assert.equal(result.credential, CURRENT)
  assert.equal(result.pending, undefined)
  assert.deepEqual(state.state.writes, [])
  assert.equal(outcome, "failed", "the reported outcome is what the client renders")
})

test("a rotation that cannot be activated keeps both credentials recorded", async () => {
  const current = authorization({ credentialExpiresAt: new Date(NOW + 20 * DAY).toISOString() })
  const state = store(current)
  const client = api({ activateError: new Error("cancelled by a reconnect") })

  const { authorization: result, outcome } = await maintainConnectorCredential({
    store: state, api: client, authorization: current, now: () => NOW,
  })


  // The live credential still works, and the pending one is retried rather than lost.
  assert.equal(result.credential, CURRENT)
  assert.equal(result.pending?.credential, ISSUED)
  assert.equal(state.state.writes.length, 1)
  assert.equal(outcome, "failed", "the reported outcome is what the client renders")
})

test("an already expired credential is not rotated", async () => {
  const expired = authorization({ credentialExpiresAt: new Date(NOW - DAY).toISOString() })
  const state = store(expired)
  const client = api()

  const { authorization: result, outcome } = await maintainConnectorCredential({
    store: state, api: client, authorization: expired, now: () => NOW,
  })


  assert.deepEqual(client.calls, [], "an expired credential was used to rotate")
  assert.equal(result.credential, CURRENT)
  assert.equal(outcome, "unchanged", "the reported outcome is what the client renders")
})
