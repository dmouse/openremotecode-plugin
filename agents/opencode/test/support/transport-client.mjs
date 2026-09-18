import assert from "node:assert/strict"
import { generateConnectorIdentity } from "@openremotecode/protocol"
import { RemoteAPIClient } from "../../dist/remote-api-client.js"
import { RelayConnection } from "../../dist/relay-connection.js"

// A child process gives each check its own test CA trust and fetch connection pool.
const [mode, origin] = process.argv.slice(2)
const api = new RemoteAPIClient(new URL(origin))
if (mode === "redirect") {
  for (const operation of [
    () => api.connectorChallenge(),
    () => api.startPairing({ name: "transport test", identity: {}, proof: {} }),
    () => api.pollPairing("par_test", "synthetic-secret"),
    () => api.cancelPairing("par_test", "synthetic-secret"),
    () => api.ownConnector("synthetic-credential"),
    () => api.revokeConnector("synthetic-credential"),
    () => api.relayAdmission("synthetic-credential"),
  ]) await assert.rejects(operation(), /fetch failed/)
} else if (mode === "untrusted") {
  await assert.rejects(api.connectorChallenge(), /fetch failed/)
} else {
  assert.equal((await api.connectorChallenge()).challenge, "A".repeat(43))
  const identity = (await generateConnectorIdentity()).identity.publicIdentity
  let connected, failed
  const ready = new Promise((resolve, reject) => { connected = resolve; failed = reject })
  const timeout = setTimeout(() => failed(new Error("WSS admission timed out")), 3000)
  const relay = new RelayConnection({
    admissionProvider: (signal) => api.relayAdmission("synthetic-credential", signal),
    hello: { protocolVersion: 2, type: "connector.hello", pluginVersion: "test", identity, capabilities: [] },
    log: async (level, message) => {
      if (message === "Connected to authenticated remote relay") connected()
      else if (level === "error" || level === "warn") failed(new Error(message))
    },
  })
  try {
    relay.start()
    await ready
  } finally {
    clearTimeout(timeout)
    await relay.stop()
  }
}
