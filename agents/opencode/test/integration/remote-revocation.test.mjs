import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { WebSocketServer } from "ws"

import { FileConnectorAuthorizationStore } from "../../dist/auth/authorization-store.js"
import { FileConnectorIdentityStore } from "../../dist/crypto/identity-store.js"
import startPlugin from "../../dist/index.js"
import tuiPlugin from "../../dist/tui.js"

test("/remote revokes via HTTP and stops the running plugin relay without a restart", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-revoke-e2e-"))
  const previousInsecure = process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK
  process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK = "true"
  const previous = process.env.OPENCODE_REMOTE_DATA_DIR
  process.env.OPENCODE_REMOTE_DATA_DIR = directory
  t.after(async () => {
    if (previousInsecure === undefined) delete process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK
    else process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK = previousInsecure
    if (previous === undefined) delete process.env.OPENCODE_REMOTE_DATA_DIR
    else process.env.OPENCODE_REMOTE_DATA_DIR = previous
    await rm(directory, { recursive: true, force: true })
  })
  // Explicitly bypass any inherited development harness configuration.
  for (const name of ["OPENCODE_REMOTE_RELAY_URL", "OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY"]) {
    const value = process.env[name]
    process.env[name] = ""
    t.after(() => { if (value === undefined) delete process.env[name]; else process.env[name] = value })
  }
  const identity = await new FileConnectorIdentityStore(path.join(directory, "connector-identity.json")).loadOrCreate()
  const credential = `orc_${"A".repeat(43)}`
  let revoked = false
  let tickets = 0
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${credential}`) {
      response.writeHead(401).end()
    } else if (request.url === "/v1/connectors/self/revoke") {
      revoked = true
      response.writeHead(204).end()
    } else if (request.url === "/v1/relay/tickets" && !revoked) {
      tickets += 1
      response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({
        ticket: `ort_${"T".repeat(43)}`, expiresAt: new Date(Date.now() + 30_000).toISOString(), webSocketUrl: "/v1/relay",
      }))
    } else response.writeHead(401).end()
  })
  const sockets = new WebSocketServer({ server, handleProtocols: () => "opencode-remote.v1" })
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise((resolve) => sockets.close(resolve))
    await new Promise((resolve) => server.close(resolve))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  const store = new FileConnectorAuthorizationStore(path.join(directory, "connector-authorization.json"))
  await store.replace({
    version: 1, serviceOrigin: origin, connectorId: "con_0123456789abcdefghijklmn",
    connectorKeyId: identity.publicIdentity.keyId, credential,
    credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(), trustedClient: identity.publicIdentity,
  })
  const logs = []
  const context = { directory, client: { app: { log: async (message) => { logs.push(message) } } } }
  // Restoring saved HTTP credentials must not implicitly opt into plaintext.
  process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK = "false"
  const blocked = await startPlugin(context, { apiUrl: origin })
  assert.equal(blocked.dispose, undefined)
  assert.equal(tickets, 0)
  assert.equal((await store.load()).credential, credential)
  process.env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK = "true"
  const connected = once(sockets, "connection", { signal: AbortSignal.timeout(3000) })
  const hooks = await startPlugin(context, { apiUrl: origin })
  t.after(() => hooks.dispose())
  const [socket] = await connected
  const [hello] = await once(socket, "message", { signal: AbortSignal.timeout(3000) })
  assert.equal(JSON.parse(hello.toString()).identity.keyId, identity.publicIdentity.keyId)
  socket.send(JSON.stringify({ protocolVersion: 1, type: "relay.ready", role: "connector", keyId: identity.publicIdentity.keyId }))
  const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) })
  let command, dialog
  const controller = new AbortController()
  t.after(() => controller.abort())
  await tuiPlugin.tui({
    theme: { current: { success: "#a3d977", textMuted: "#888888", text: "#ffffff" } },
    slots: { register() { return "status-chip" } },
    keymap: { registerLayer(layer) { command = layer.commands[0]; return () => {} } },
    lifecycle: { signal: controller.signal, onDispose() {} },
    ui: {
      DialogSelect: (props) => props, DialogConfirm: (props) => props,
      dialog: { setSize() {}, replace(render) { dialog = render() }, clear() {} },
    },
  })
  await command.run()
  assert.equal(dialog.options.some((option) => option.value === "revoke"), false)
  dialog.onSelect(dialog.options.find((option) => option.value === "details"))
  assert.equal(dialog.title, "Active token details")
  dialog.onSelect({ value: "revoke" })
  dialog.onConfirm()
  // The simulated service intentionally leaves the socket open: the local plugin must stop it.
  await closed
  assert.equal(revoked, true)
  assert.equal(await store.load(), undefined)
  assert.equal(dialog.options[0].title, "Remote access revoked")
  await delay(600)
  assert.equal(tickets, 1)
  assert.equal(JSON.stringify(logs).includes(credential), false)
})
