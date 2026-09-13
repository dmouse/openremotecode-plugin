import assert from "node:assert/strict"
import test from "node:test"

import { monitorAuthorization } from "../../dist/auth/authorization-monitor.js"

const authorization = {
  credential: "test-credential",
  serviceOrigin: "https://remote.example.test",
  connectorKeyId: "test-key",
  credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
}

test("removing local authorization stops the relay without waiting for reconnect", async () => {
  let current = authorization
  let checks = 0
  let stopped = false
  const controller = new AbortController()
  const task = monitorAuthorization({ load: async () => {
    checks += 1
    const result = current
    current = undefined
    return result
  } }, authorization, async () => { stopped = true }, controller.signal)
  await task
  assert.equal(checks, 2)
  assert.equal(stopped, true)
})

test("changed, expired, or unreadable authorization fails closed", async () => {
  for (const current of [undefined, { ...authorization, credential: "replacement" },
    { ...authorization, serviceOrigin: "https://another.example.test" },
    { ...authorization, connectorKeyId: "other-key" },
    { ...authorization, credentialExpiresAt: "2000-01-01T00:00:00Z" }, new Error("unreadable")]) {
    let stopped = 0
    await monitorAuthorization({ load: async () => {
      if (current instanceof Error) throw current
      return current
    } }, authorization, async () => { stopped += 1 }, new AbortController().signal)
    assert.equal(stopped, 1)
  }
})

test("disposing cancels the authorization monitor", async () => {
  const controller = new AbortController()
  await monitorAuthorization({ load: async () => {
    controller.abort()
    return authorization
  } }, authorization, async () => assert.fail("unexpected revocation"), controller.signal)
})
