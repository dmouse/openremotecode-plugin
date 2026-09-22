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

import { generateConnectorIdentity } from "@openremotecode/protocol"

const EXPECTED_OPENCODE_VERSION = "1.18.31"
const opencodeBinary = process.env.OPENCODE_TEST_BINARY || "opencode"
const pluginRoot = fileURLToPath(new URL("../../", import.meta.url))
const builtPlugin = path.join(pluginRoot, "dist", "index.js")

// Two OpenCode processes, one per project directory, share this machine's connector identity.
// The relay evicts the older connection when an identity reconnects, exactly as production does,
// so without a single owner they would evict each other in a loop and neither project would
// stay reachable from the phone.
test("two OpenCode instances sharing one identity keep a single stable relay connection and fail over", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "opencode-remote-multi-"))
  const shared = Object.fromEntries(["home", "config", "data", "cache"].map((name) => [name, path.join(temporaryRoot, name)]))
  const workspaces = [path.join(temporaryRoot, "project-one"), path.join(temporaryRoot, "project-two")]
  await Promise.all([...Object.values(shared), ...workspaces].map((directory) => mkdir(directory, { recursive: true })))

  const connector = await generateConnectorIdentity()
  const client = await generateConnectorIdentity()
  const credential = `orc_${"b".repeat(43)}`
  const remote = await createEvictingRelay(credential)
  const dataDirectory = path.join(shared.data, "opencode-remote")
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(dataDirectory, "connector-identity.json"),
    `${JSON.stringify(connector.serialized, null, 2)}\n`, { mode: 0o600 })
  await writeFile(path.join(dataDirectory, "connector-authorization.json"), `${JSON.stringify({
    version: 1,
    serviceOrigin: remote.origin,
    connectorId: "con_0123456789abcdefghijklmn",
    connectorKeyId: connector.identity.publicIdentity.keyId,
    credential,
    credentialExpiresAt: "2027-01-01T00:00:00.000Z",
    trustedClient: client.identity.publicIdentity,
  }, null, 2)}\n`, { mode: 0o600 })
  for (const workspace of workspaces) {
    await writeFile(path.join(workspace, "opencode.json"), `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      share: "disabled",
      plugin: [pathToFileURL(builtPlugin).href],
    }, null, 2)}\n`)
  }

  const running = []
  let output = ""
  try {
    const launch = async (workspace) => {
      const port = await reservePort()
      const child = launchOpenCode(shared, workspace, port, remote.origin, (chunk) => { output += chunk })
      running.push(child)
      await waitForHealth(port, child)
      await activateWorkspace(port, workspace)
      return child
    }

    const first = await launch(workspaces[0])
    await eventually(() => remote.connections === 1, "the first instance should connect")
    await launch(workspaces[1])

    // A second contender would evict the first within a second or so and be evicted back.
    await delay(4_000)
    assert.equal(remote.connections, 1, "the second instance must not connect while the first owns the relay")
    assert.equal(remote.evictions, 0, "no connection may be evicted by a sibling instance")

    // When the owner exits, the waiting instance takes over the relay.
    await stopProcess(first)
    await eventually(() => remote.connections === 2, "the remaining instance should take over", 20_000)
    await delay(2_000)
    assert.equal(remote.connections, 2, "the takeover must be a single connection, not a contest")
    assert.equal(remote.evictions, 0)
  } catch (error) {
    throw new Error(`Multi-instance integration failed.\n\n${output}`, { cause: error })
  } finally {
    for (const child of running) await stopProcess(child)
    await remote.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

async function eventually(condition, message, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (condition()) return
    await delay(100)
  }
  assert.fail(`Timed out: ${message}`)
}

async function createEvictingRelay(expectedCredential) {
  let tickets = 0
  const unusedTickets = new Set()
  const live = new Set()
  const state = { connections: 0, evictions: 0 }
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
    tickets += 1
    const ticket = `ort_${String(tickets).padStart(43, "a")}`
    unusedTickets.add(ticket)
    response.writeHead(201, { "content-type": "application/json" })
    response.end(JSON.stringify({ ticket, expiresAt: new Date(Date.now() + 30_000).toISOString(), webSocketUrl: "/v1/relay" }))
  })
  server.on("upgrade", (request, socket, head) => {
    const protocols = String(request.headers["sec-websocket-protocol"] || "").split(",").map((value) => value.trim())
    const ticket = protocols.find((value) => value.startsWith("ticket."))?.slice("ticket.".length)
    if (!protocols.includes("opencode-remote.v1") || !ticket || !unusedTickets.delete(ticket)) {
      socket.destroy()
      return
    }
    relay.handleUpgrade(request, socket, head, (webSocket) => relay.emit("connection", webSocket, request))
  })
  relay.on("connection", (socket) => {
    socket.once("message", (data) => {
      const hello = JSON.parse(data.toString())
      // Same rule as the production relay: a new connection for an identity replaces the old.
      for (const previous of live) {
        state.evictions += 1
        previous.close(1000, "Replaced by a newer connection")
      }
      live.clear()
      live.add(socket)
      socket.once("close", () => live.delete(socket))
      state.connections += 1
      socket.send(JSON.stringify({ protocolVersion: 2, type: "relay.ready", role: "connector", keyId: hello.identity.keyId }))
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get connections() { return state.connections },
    get evictions() { return state.evictions },
    async close() {
      for (const socket of relay.clients) socket.terminate()
      await new Promise((resolve) => relay.close(resolve))
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function launchOpenCode(shared, workspace, port, serviceOrigin, appendOutput) {
  const child = spawn(opencodeBinary, [
    "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "DEBUG",
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: shared.home,
      XDG_CONFIG_HOME: shared.config,
      XDG_DATA_HOME: shared.data,
      XDG_CACHE_HOME: shared.cache,
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

async function waitForHealth(port, child) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited with code ${child.exitCode}`)
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
  assert.ok(address && typeof address !== "string")
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  const graceful = waitForExit(child, 2_000)
  child.kill("SIGTERM")
  if (await graceful) return
  const forced = waitForExit(child, 2_000)
  child.kill("SIGKILL")
  await forced
}

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timeout); resolve(true) }
    const timeout = setTimeout(() => { child.off("exit", onExit); resolve(false) }, milliseconds)
    child.once("exit", onExit)
  })
}
