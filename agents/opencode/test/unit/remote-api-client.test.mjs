import assert from "node:assert/strict"
import test from "node:test"

import { RemoteAPIClient } from "../../dist/remote-api-client.js"

test("pairing response preserves server linkedAt and accepts older responses", async () => {
  const document = {
    status: "completed", pairingId: "par_test", serviceId: "test", expiresAt: "2027-01-01T00:00:00Z",
    linkedAt: "2026-09-01T10:30:00Z",
  }
  const client = new RemoteAPIClient(new URL("https://remote.example.test"), async () => Response.json(document))
  assert.equal((await client.pollPairing("par_test", "secret")).linkedAt, document.linkedAt)
  document.linkedAt = "invalid"
  await assert.rejects(client.pollPairing("par_test", "secret"), /invalid response/)
  delete document.linkedAt
  assert.equal((await client.pollPairing("par_test", "secret")).linkedAt, undefined)
})

test("connector revocation uses its own bearer credential, a bounded request, and no redirects", async () => {
  let captured
  const client = new RemoteAPIClient(new URL("https://remote.example.test"), async (url, init) => {
    captured = { url: url.toString(), init }
    return new Response(null, { status: 204 })
  })
  const credential = `orc_${"A".repeat(43)}`
  await client.revokeConnector(credential)
  assert.equal(captured.url, "https://remote.example.test/v1/connectors/self/revoke")
  assert.equal(captured.init.method, "POST")
  assert.equal(captured.init.headers.Authorization, `Bearer ${credential}`)
  assert.equal(captured.init.redirect, "error")
  assert.equal(captured.init.cache, "no-store")
  assert.ok(captured.init.signal instanceof AbortSignal)
  assert.equal(captured.init.body, undefined)
})

test("pairing cancellation authenticates with the private pairing secret", async () => {
  let captured
  const request = async (url, init) => {
    captured = { url: url.toString(), init }
    return new Response(null, { status: 204 })
  }
  const client = new RemoteAPIClient(new URL("https://remote.example.test"), request)
  const pairingId = "par_0123456789abcdefghijklmn"
  const pairingSecret = `orp_${"A".repeat(43)}`

  await client.cancelPairing(pairingId, pairingSecret)

  assert.equal(captured.url, `https://remote.example.test/v1/connector-pairings/${pairingId}/cancel`)
  assert.equal(captured.init.method, "POST")
  assert.equal(captured.init.headers.Authorization, `Pairing ${pairingSecret}`)
})

test("every API operation rejects redirects and applies bounded uncached requests", async () => {
  const calls = []
  const client = new RemoteAPIClient(new URL("https://remote.example.test"), async (url, init) => {
    calls.push(url.pathname)
    assert.equal(init.redirect, "error", url.pathname)
    assert.equal(init.cache, "no-store", url.pathname)
    assert.ok(init.signal instanceof AbortSignal)
    throw new Error("request stopped at transport boundary")
  })
  for (const operation of [
    () => client.connectorChallenge(),
    () => client.startPairing({ name: "test", identity: {}, proof: {} }),
    () => client.pollPairing("par_test", "synthetic-secret"),
    () => client.cancelPairing("par_test", "synthetic-secret"),
    () => client.ownConnector("synthetic-credential"),
    () => client.revokeConnector("synthetic-credential"),
    () => client.relayAdmission("synthetic-credential"),
  ]) await assert.rejects(operation(), /transport boundary/)
  assert.equal(calls.length, 7)
})

test("relay admission accepts only the contracted same-origin path", async (t) => {
  const previous = process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK
  process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK = "true"
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK
    else process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK = previous
  })
  for (const origin of ["https://remote.example.test", "http://localhost:8080", "http://[::1]:8080"]) {
    let webSocketUrl = "/v1/relay"
    const client = new RemoteAPIClient(new URL(origin), async () => Response.json({
      ticket: "ort_synthetic", expiresAt: "2027-01-01T00:00:00Z", webSocketUrl,
    }))
    const admission = await client.relayAdmission("synthetic-credential")
    assert.equal(admission.url.href, origin.replace(/^http/u, "ws") + "/v1/relay")
    assert.deepEqual(admission.protocols, ["opencode-remote.v1", "ticket.ort_synthetic"])
    for (const value of [
      "/\\attacker.example.test/v1/relay", "//attacker.example.test/v1/relay",
      "/\t/attacker.example.test/v1/relay", "/%5Cattacker.example.test/v1/relay",
      "https://attacker.example.test/v1/relay", "http://attacker.example.test/v1/relay",
      `${origin}/v1/relay`, "wss://remote.example.test/v1/relay",
      "//user:secret@remote.example.test/v1/relay", "/v1/relay?ticket=secret", "/v1/relay#secret",
      "/v1/relay?", "/v1/relay#", "/other", "/v1/relay/", "/x/../v1/relay", " /v1/relay",
    ]) {
      webSocketUrl = value
      await assert.rejects(client.relayAdmission("synthetic-credential"), /invalid WebSocket URL/)
    }
  }
})

test("the API boundary validates and pins its origin before sending credentials", async (t) => {
  const previous = process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK
  delete process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK
    else process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK = previous
  })
  for (const origin of ["http://localhost", "http://remote.example.test", "https://user:secret@remote.example.test"]) {
    assert.throws(() => new RemoteAPIClient(new URL(origin), async () => assert.fail("must not send credentials")))
  }
  const origin = new URL("https://remote.example.test")
  const client = new RemoteAPIClient(origin, async (url) => {
    assert.equal(url.origin, "https://remote.example.test")
    return new Response(null, { status: 204 })
  })
  origin.hostname = "attacker.example.test"
  client.serviceOrigin.hostname = "attacker.example.test"
  await client.revokeConnector("synthetic-credential")
})
