import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { WebSocketServer } from "ws"

const execute = promisify(execFile)
const clientScript = fileURLToPath(new URL("../support/transport-client.mjs", import.meta.url))

test("TLS transports reject redirects and require certificate verification", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-tls-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const certFile = path.join(directory, "cert.pem")
  const keyFile = path.join(directory, "key.pem")
  // Generate disposable keys at runtime; no private key fixtures are committed.
  await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { timeout: 10000 })
  let targetHits = 0
  let sourceHits = 0
  let redirect
  const plaintext = createServer((_request, response) => {
    targetHits++
    response.writeHead(200, { "content-type": "application/json" }).end("{}")
  })
  const secure = createSecureServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (request, response) => {
    assert.equal(request.socket.encrypted, true)
    if (request.url === "/redirected") {
      targetHits++
      response.writeHead(200, { "content-type": "application/json" }).end("{}")
      return
    }
    sourceHits++
    if (redirect) {
      response.writeHead(redirect.status, { location: redirect.location }).end()
      return
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(
      request.url === "/v1/connector-pairings/challenge"
        ? { challenge: "A".repeat(43), expiresAt: new Date(Date.now() + 30000).toISOString() }
        : { ticket: "ort_transport_test", expiresAt: new Date(Date.now() + 30000).toISOString(), webSocketUrl: "/v1/relay" },
    ))
  })
  const sockets = new WebSocketServer({ server: secure, path: "/v1/relay", handleProtocols: () => "opencode-remote.v1" })
  let websocketConnections = 0
  sockets.on("connection", (socket, request) => {
    websocketConnections++
    assert.equal(request.socket.encrypted, true)
    assert.equal(request.headers["sec-websocket-protocol"].includes("ticket.ort_transport_test"), true)
    socket.once("message", (data) => {
      const hello = JSON.parse(data.toString())
      socket.send(JSON.stringify({ protocolVersion: 2, type: "relay.ready", role: "connector", keyId: hello.identity.keyId }))
    })
  })
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise((resolve) => sockets.close(resolve))
    secure.closeAllConnections()
    plaintext.closeAllConnections()
    await Promise.all([secure, plaintext].map((server) => new Promise((resolve) => server.close(resolve))))
  })
  for (const server of [secure, plaintext]) {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
  }
  const origin = `https://127.0.0.1:${secure.address().port}`
  const runClient = async (mode, trust = true, insecure = "false") => {
    const environment = {
      ...process.env, NODE_EXTRA_CA_CERTS: trust ? certFile : "",
      OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK: insecure,
    }
    delete environment.NODE_TLS_REJECT_UNAUTHORIZED
    await execute(process.execPath, [clientScript, mode, origin], { env: environment, timeout: 10000 })
  }
  await t.test("HTTPS admission and WSS work with a trusted certificate and secure defaults", async () => {
    await runClient("connect")
    assert.equal(websocketConnections, 1)
  })
  await t.test("loopback opt-in never disables TLS certificate verification", async () => {
    const before = sourceHits
    await runClient("untrusted", false, "false")
    await runClient("untrusted", false, "true")
    assert.equal(sourceHits, before)
  })
  for (const status of [301, 302, 303, 307, 308]) {
    for (const location of [
      `http://127.0.0.1:${plaintext.address().port}/redirected`,
      `https://localhost:${secure.address().port}/redirected`,
      `${origin}/redirected`,
    ]) {
      await t.test(`all API calls reject ${status} redirects to ${new URL(location).origin}`, async () => {
        redirect = { status, location }
        const before = sourceHits
        await runClient("redirect")
        assert.equal(sourceHits - before, 7)
        assert.equal(targetHits, 0)
      })
    }
  }
})
