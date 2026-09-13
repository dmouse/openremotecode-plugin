import assert from "node:assert/strict"
import test from "node:test"

import { supervisePairing } from "../../dist/pairing-supervisor.js"

test("pairing supervisor retries failed authorizations and stops after success", async () => {
  const controller = new AbortController()
  const authorization = { connectorId: "con_test" }
  const failures = []
  let attempts = 0
  let paired

  await supervisePairing({
    signal: controller.signal,
    retryDelay: () => 0,
    pair: async () => {
      attempts += 1
      if (attempts < 3) throw new Error(`attempt ${attempts}`)
      return authorization
    },
    onFailure: (error) => failures.push(error.message),
    onPaired: (value) => { paired = value },
  })

  assert.equal(attempts, 3)
  assert.deepEqual(failures, ["attempt 1", "attempt 2"])
  assert.equal(paired, authorization)
})

test("pairing supervisor exits when its active attempt is aborted", async () => {
  const controller = new AbortController()
  let paired = false
  const running = supervisePairing({
    signal: controller.signal,
    pair: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }),
    onFailure: () => assert.fail("abort must not be reported as a pairing failure"),
    onPaired: () => { paired = true },
  })

  controller.abort(new Error("test complete"))
  await running
  assert.equal(paired, false)
})
