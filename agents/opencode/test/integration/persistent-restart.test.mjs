import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

import { WebSocketServer } from "ws"

import { connectorHelloSchema, generateConnectorIdentity } from "@openremotecode/protocol"

const EXPECTED_OPENCODE_VERSION = "1.18.31"
const opencodeBinary = process.env.OPENCODE_TEST_BINARY || "opencode"
const pluginRoot = fileURLToPath(new URL("../../", import.meta.url))
const builtPlugin = path.join(pluginRoot, "dist", "index.js")

for (const configuration of ["environment", "plugin options"]) {
  test(`real OpenCode restart restores connector authorization and gets a fresh ticket using ${configuration}`, async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "opencode-remote-restart-"))
    const directories = Object.fromEntries(
      ["workspace", "home", "config", "data", "cache"].map((name) => [name, path.join(temporaryRoot, name)]),
    )
    await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true })))

    const connector = await generateConnectorIdentity()
    const client = await generateConnectorIdentity()
    const credential = `orc_${"a".repeat(43)}`
    const remote = await createAuthenticatedRelay(credential)
    const dataDirectory = path.join(directories.data, "opencode-remote")
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(dataDirectory, "connector-identity.json"),
      `${JSON.stringify(connector.serialized, null, 2)}\n`,
      { mode: 0o600 },
    )
    await writeFile(
      path.join(dataDirectory, "connector-authorization.json"),
      `${JSON.stringify({
        version: 1,
        serviceOrigin: remote.origin,
        connectorId: "con_0123456789abcdefghijklmn",
        connectorKeyId: connector.identity.publicIdentity.keyId,
        credential,
        credentialExpiresAt: "2027-01-01T00:00:00.000Z",
        trustedClient: client.identity.publicIdentity,
      }, null, 2)}\n`,
      { mode: 0o600 },
    )
    await writeFile(
      path.join(directories.workspace, "opencode.json"),
      `${JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        share: "disabled",
        plugin: [configuration === "plugin options"
          ? [pathToFileURL(builtPlugin).href, { apiUrl: remote.origin }]
          : pathToFileURL(builtPlugin).href],
      }, null, 2)}\n`,
    )

    const identities = []
    let activeProcess
    let output = ""
    try {
      for (let launch = 0; launch < 2; launch += 1) {
        const opencodePort = await reservePort()
        const hello = remote.nextHello()
        activeProcess = launchOpenCode(
          directories,
          opencodePort,
          configuration === "plugin options" ? "https://unused.example.test" : remote.origin,
          (chunk) => { output += chunk },
        )
        await waitForHealth(opencodePort, activeProcess)
        await activateWorkspace(opencodePort, directories.workspace)
        identities.push(connectorHelloSchema.parse(await withTimeout(hello, 10_000, "Timed out waiting for authenticated connector hello")).identity)
        await stopProcess(activeProcess)
        activeProcess = undefined
      }

      assert.deepEqual(identities, [connector.identity.publicIdentity, connector.identity.publicIdentity])
      assert.equal(remote.tickets.length, 2)
      assert.notEqual(remote.tickets[0], remote.tickets[1])
    } catch (error) {
      throw new Error(`Persistent restart integration failed.\n\n${output}`, { cause: error })
    } finally {
      if (activeProcess) await stopProcess(activeProcess)
      await remote.close()
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
}

async function createAuthenticatedRelay(expectedCredential) {
  const tickets = []
  const unusedTickets = new Set()
  const helloWaiters = []
  const relay = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => protocols.has("opencode-remote.v1") ? "opencode-remote.v1" : false,
  })
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/relay/tickets" || request.headers.authorization !== `Bearer ${expectedCredential}`) {
      response.writeHead(401, { "content-type": "application/json" })
      response.end('{"code":"unauthorized","message":"Unauthorized"}')
      return
    }
    const ticket = `ort_${String(tickets.length + 1).padStart(43, "a")}`
    tickets.push(ticket)
    unusedTickets.add(ticket)
    response.writeHead(201, { "content-type": "application/json" })
    response.end(JSON.stringify({
      ticket,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      webSocketUrl: "/v1/relay",
    }))
  })
  server.on("upgrade", (request, socket, head) => {
    const protocols = String(request.headers["sec-websocket-protocol"] || "").split(",").map((value) => value.trim())
    const ticketProtocol = protocols.find((value) => value.startsWith("ticket."))
    const ticket = ticketProtocol?.slice("ticket.".length)
    if (!protocols.includes("opencode-remote.v1") || !ticket || !unusedTickets.delete(ticket)) {
      socket.destroy()
      return
    }
    relay.handleUpgrade(request, socket, head, (webSocket) => relay.emit("connection", webSocket, request))
  })
  relay.on("connection", (socket) => {
    socket.once("message", (data) => {
      const hello = JSON.parse(data.toString())
      socket.send(JSON.stringify({
        protocolVersion: 2,
        type: "relay.ready",
        role: "connector",
        keyId: hello.identity.keyId,
      }))
      helloWaiters.shift()?.resolve(hello)
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.notEqual(typeof address, "string")
  assert.ok(address)
  return {
    origin: `http://127.0.0.1:${address.port}`,
    tickets,
    nextHello() {
      return new Promise((resolve, reject) => helloWaiters.push({ resolve, reject }))
    },
    async close() {
      for (const client of relay.clients) client.terminate()
      await new Promise((resolve) => relay.close(resolve))
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function launchOpenCode(directories, port, serviceOrigin, appendOutput) {
  const child = spawn(opencodeBinary, [
    "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "DEBUG",
  ], {
    cwd: directories.workspace,
    env: {
      ...process.env,
      HOME: directories.home,
      XDG_CONFIG_HOME: directories.config,
      XDG_DATA_HOME: directories.data,
      XDG_CACHE_HOME: directories.cache,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK: "true",
      OPENCODE_REMOTE_SERVER_URL: serviceOrigin,
      OPENCODE_REMOTE_RELAY_URL: "",
      OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", appendOutput)
  child.stderr.on("data", appendOutput)
  return child
}

async function waitForHealth(port, process) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`OpenCode exited with code ${process.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/global/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        const health = await response.json()
        if (health.healthy) {
          assert.equal(health.version, EXPECTED_OPENCODE_VERSION)
          return
        }
      }
    } catch { /* OpenCode has not bound its port yet. */ }
    await delay(100)
  }
  throw new Error("Timed out waiting for OpenCode health")
}

async function activateWorkspace(port, workspace) {
  const url = new URL(`http://127.0.0.1:${port}/session`)
  url.searchParams.set("directory", workspace)
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200)
}

async function reservePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.notEqual(typeof address, "string")
  assert.ok(address)
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function stopProcess(process) {
  if (process.exitCode !== null) return
  const graceful = waitForExit(process, 2_000)
  process.kill("SIGTERM")
  if (await graceful) return
  const forced = waitForExit(process, 2_000)
  process.kill("SIGKILL")
  await forced
}

function waitForExit(process, milliseconds) {
  if (process.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timeout); resolve(true) }
    const timeout = setTimeout(() => { process.off("exit", onExit); resolve(false) }, milliseconds)
    process.once("exit", onExit)
  })
}

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    delay(milliseconds).then(() => { throw new Error(message) }),
  ])
}
