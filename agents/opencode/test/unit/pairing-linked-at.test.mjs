import assert from "node:assert/strict"
import test from "node:test"
import { generateConnectorIdentity } from "@openremotecode/protocol"
import { PairingClient } from "../../dist/pairing-client.js"
import { RemoteAPIClient } from "../../dist/remote-api-client.js"

test("completed pairing persists the server's original linking date", async () => {
  const { identity } = await generateConnectorIdentity()
  const trusted = (await generateConnectorIdentity()).identity.publicIdentity
  const linkedAt = "2026-09-01T10:30:00Z"
  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  const pairing = {
    serviceOrigin: "https://remote.example.test", connectorKeyId: identity.publicIdentity.keyId,
    pairingId: "par_0123456789abcdefghijklmn", pairingSecret: "secret", serviceId: "test", expiresAt,
    pollIntervalSeconds: 0, userCode: "TEST-CODE", verificationUri: "https://remote.example.test/pair",
  }
  const api = new RemoteAPIClient(new URL(pairing.serviceOrigin), async () => Response.json({
    status: "completed", pairingId: pairing.pairingId, serviceId: pairing.serviceId, expiresAt,
    connectorId: "con_0123456789abcdefghijklmn", connectorCredential: `orc_${"A".repeat(43)}`,
    connectorCredentialExpiresAt: expiresAt, linkedAt,
    transcript: { version: 1, serviceId: pairing.serviceId, pairingId: pairing.pairingId,
      connectorIdentity: identity.publicIdentity, deviceIdentity: trusted },
  }))
  let saved, cleared = false
  const client = new PairingClient(api, identity, { replace: async (value) => { saved = value } },
    { load: async () => pairing, clear: async () => { cleared = true } },
    { showPairing: async () => {}, approveDevice: async () => true })
  const result = await client.pair(new AbortController().signal)
  assert.equal(result.linkedAt, linkedAt)
  assert.equal(saved.linkedAt, linkedAt)
  assert.equal(cleared, true)
})
