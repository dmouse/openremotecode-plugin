import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  CONNECTOR_CREDENTIAL_CAPABILITIES,
  CONNECTOR_CREDENTIAL_UPDATED_OPERATION,
  CONNECTOR_CREDENTIAL_VERSION,
  connectorCredentialUpdatedEventSchema,
  connectorCredentialUpdatedSchema,
  RELAY_PROTOCOL_VERSION,
} from "../dist/index.js"

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/connector-credential-v1.json", import.meta.url), "utf8"),
)

test("the shared fixture describes the contract both languages implement", () => {
  assert.equal(fixture.version, CONNECTOR_CREDENTIAL_VERSION)
  assert.equal(fixture.operation, CONNECTOR_CREDENTIAL_UPDATED_OPERATION)
  assert.deepEqual(CONNECTOR_CREDENTIAL_CAPABILITIES, [CONNECTOR_CREDENTIAL_UPDATED_OPERATION])

  for (const outcome of ["renewed", "failed"]) {
    assert.deepEqual(connectorCredentialUpdatedSchema.parse(fixture[outcome]), fixture[outcome])
  }
  assert.deepEqual(connectorCredentialUpdatedEventSchema.parse(fixture.event), fixture.event)
  assert.equal(fixture.event.protocolVersion, RELAY_PROTOCOL_VERSION)
})

test("the body carries an outcome and nothing that could leak a credential", () => {
  for (const [name, body] of Object.entries(fixture.rejected)) {
    assert.equal(connectorCredentialUpdatedSchema.safeParse(body).success, false, name)
  }
  // The strict schema is what keeps a credential, a connector id, or free-form service
  // error text out of a payload the client will render.
  assert.deepEqual(Object.keys(fixture.renewed).sort(), ["occurredAt", "outcome", "version"])
})

test("the event is unsolicited, so its requestId correlates with nothing", () => {
  // Unlike the subscription events, no refine ties requestId to a body field; any UUID is
  // valid, and a non-UUID is not.
  const requestId = "1d1f7a52-9c3e-4c1f-bb7a-6d2c8e4f0a13"
  assert.equal(
    connectorCredentialUpdatedEventSchema.parse({ ...fixture.event, requestId }).requestId,
    requestId,
  )
  for (const invalid of ["not-a-uuid", "", fixture.operation]) {
    assert.equal(
      connectorCredentialUpdatedEventSchema.safeParse({ ...fixture.event, requestId: invalid }).success,
      false,
    )
  }
  for (const override of [{ kind: "response" }, { operation: "connector.credential.rotated" }, { protocolVersion: 1 }]) {
    assert.equal(connectorCredentialUpdatedEventSchema.safeParse({ ...fixture.event, ...override }).success, false)
  }
})
