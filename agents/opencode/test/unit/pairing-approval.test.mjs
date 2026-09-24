import assert from "node:assert/strict"
import test from "node:test"
import { generateConnectorIdentity } from "@openremotecode/protocol"
import { PairingClient, PairingRejectedError } from "../../dist/pairing-client.js"
import { RemoteAPIClient } from "../../dist/remote-api-client.js"

// A scripted service: the pairing is in verification (a phone claimed it) until the connector
// approves, then completes. Every request is recorded so the tests can see what was sent.
async function fixture({ approveFailures = 0 } = {}) {
  const { identity } = await generateConnectorIdentity()
  const device = (await generateConnectorIdentity()).identity.publicIdentity
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  const pairing = {
    serviceOrigin: "https://remote.example.test", connectorKeyId: identity.publicIdentity.keyId,
    pairingId: "par_0123456789abcdefghijklmn", pairingSecret: "secret", serviceId: "test", expiresAt,
    pollIntervalSeconds: 0, userCode: "TEST-CODE", verificationUri: "https://remote.example.test/pair",
  }
  const transcript = { version: 1, serviceId: pairing.serviceId, pairingId: pairing.pairingId,
    connectorIdentity: identity.publicIdentity, deviceIdentity: device }
  const requests = []
  let approved = false
  let failures = approveFailures
  const api = new RemoteAPIClient(new URL(pairing.serviceOrigin), async (url, init) => {
    const path = new URL(url).pathname
    requests.push({ path, body: init.body ? JSON.parse(init.body) : undefined, authorization: init.headers.Authorization })
    if (path.endsWith("/approve")) {
      if (failures > 0) { failures -= 1; return Response.json({ message: "unavailable" }, { status: 503 }) }
      approved = true
      return new Response(null, { status: 204 })
    }
    if (path.endsWith("/cancel")) return new Response(null, { status: 204 })
    if (!approved) return Response.json({ status: "verification", pairingId: pairing.pairingId, serviceId: pairing.serviceId, expiresAt, transcript })
    return Response.json({ status: "completed", pairingId: pairing.pairingId, serviceId: pairing.serviceId, expiresAt,
      connectorId: "con_0123456789abcdefghijklmn", connectorCredential: `orc_${"A".repeat(43)}`,
      connectorCredentialExpiresAt: expiresAt, transcript })
  })
  const state = { cleared: false, saved: undefined }
  const make = (approveDevice) => new PairingClient(api, identity,
    { replace: async (value) => { state.saved = value } },
    { load: async () => pairing, clear: async () => { state.cleared = true } },
    { showPairing: async () => {}, approveDevice })
  return { make, requests, device, state }
}

test("pairing completes only after the user approves the reviewed device", async () => {
  const { make, requests, device, state } = await fixture()
  const asked = []
  const result = await make(async (code) => { asked.push(code); return true }).pair(new AbortController().signal)
  assert.equal(asked.length, 1, "the user is asked exactly once")
  assert.match(asked[0], /\S/, "the dialog carries the safety code")
  const approval = requests.find((request) => request.path.endsWith("/approve"))
  assert.ok(approval, "the approval was sent to the service")
  assert.deepEqual(approval.body, { deviceKeyId: device.keyId }, "the approval is bound to the device that was shown")
  assert.equal(approval.authorization, "Pairing secret")
  assert.deepEqual(result.trustedClient, device)
  assert.ok(state.saved)
})

test("rejecting the device cancels the pairing and never approves it", async () => {
  const { make, requests, state } = await fixture()
  await assert.rejects(make(async () => false).pair(new AbortController().signal), PairingRejectedError)
  assert.ok(requests.some((request) => request.path.endsWith("/cancel")), "the pairing was cancelled")
  assert.ok(!requests.some((request) => request.path.endsWith("/approve")), "nothing was approved")
  assert.equal(state.cleared, true, "the local pending pairing was discarded")
  assert.equal(state.saved, undefined)
})

test("a failed approval request is retried without asking the user again", async () => {
  const { make, requests } = await fixture({ approveFailures: 2 })
  let asked = 0
  await make(async () => { asked += 1; return true }).pair(new AbortController().signal)
  assert.equal(asked, 1)
  assert.equal(requests.filter((request) => request.path.endsWith("/approve")).length, 3)
})
