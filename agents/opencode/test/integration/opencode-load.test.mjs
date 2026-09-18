import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

import { WebSocketServer } from "ws"

import {
  connectorHelloSchema,
  CHAT_CAPABILITIES,
  PROJECT_MCP_CAPABILITIES,
  CHAT_STREAM_CAPABILITIES,
  decryptRelayEnvelope,
  encryptRelayPayload,
  deriveRelayEpoch,
  generateConnectorIdentity,
  generateRelayNonce,
  RELAY_PROTOCOL_VERSION,
  sessionListResponseBodySchema,
} from "@openremotecode/protocol"

const EXPECTED_OPENCODE_VERSION = "1.18.30"
const opencodeBinary = process.env.OPENCODE_TEST_BINARY || "opencode"
const pluginRoot = fileURLToPath(new URL("../../", import.meta.url))
const builtPlugin = path.join(pluginRoot, "dist", "index.js")

test("real OpenCode serves an encrypted session.list through the plugin", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "opencode-remote-integration-"),
  )
  const workspace = path.join(temporaryRoot, "workspace")
  const home = path.join(temporaryRoot, "home")
  const configHome = path.join(temporaryRoot, "config")
  const dataHome = path.join(temporaryRoot, "data")
  const cacheHome = path.join(temporaryRoot, "cache")
  await Promise.all(
    [workspace, home, configHome, dataHome, cacheHome].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  )

  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(relay, "listening")
  const relayAddress = relay.address()
  assert.notEqual(typeof relayAddress, "string")
  assert.ok(relayAddress)

  const client = await generateConnectorIdentity()
  const hello = waitForHello(relay)
  const opencodePort = await reservePort()
  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    plugin: [pathToFileURL(builtPlugin).href],
  }
  await writeFile(
    path.join(workspace, "opencode.json"),
    `${JSON.stringify(opencodeConfig, null, 2)}\n`,
  )

  let output = ""
  const opencode = spawn(
    opencodeBinary,
    [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(opencodePort),
      "--print-logs",
      "--log-level",
      "DEBUG",
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_CACHE_HOME: cacheHome,
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
        OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK: "true",
        OPENCODE_REMOTE_RELAY_URL: `ws://127.0.0.1:${relayAddress.port}`,
        OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY: JSON.stringify(
          client.identity.publicIdentity,
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  opencode.stdout.setEncoding("utf8")
  opencode.stderr.setEncoding("utf8")
  opencode.stdout.on("data", (chunk) => {
    output += chunk
  })
  opencode.stderr.on("data", (chunk) => {
    output += chunk
  })

  try {
    await waitForHealth(opencodePort, opencode)
    await activateWorkspace(opencodePort, workspace)
    const connection = await withTimeout(
      hello,
      10_000,
      "Timed out waiting for connector hello",
    )
    await waitForSdkLog(() => output, opencode)
    const message = connectorHelloSchema.parse(connection.message)

    assert.equal(message.protocolVersion, RELAY_PROTOCOL_VERSION)
    assert.equal(message.type, "connector.hello")
    assert.equal(message.pluginVersion, "0.1.0")
    assert.deepEqual(message.capabilities, ["session.list", ...CHAT_CAPABILITIES, ...PROJECT_MCP_CAPABILITIES, ...CHAT_STREAM_CAPABILITIES])
    assert.match(message.identity.keyId, /^[A-Za-z0-9_-]{43}$/u)
    assert.match(message.identity.publicKey, /^[A-Za-z0-9_-]+$/u)

    const identityPath = path.join(
      dataHome,
      "opencode-remote",
      "connector-identity.json",
    )
    const persistedIdentity = JSON.parse(await readFile(identityPath, "utf8"))
    assert.equal(persistedIdentity.keyId, message.identity.keyId)
    if (process.platform !== "win32") {
      const identityFile = await stat(identityPath)
      assert.equal(identityFile.mode & 0o777, 0o600)
    }

    const clientNonce = generateRelayNonce()
    const epoch = await deriveRelayEpoch({
      connectorKeyId: message.identity.keyId,
      connectorNonce: message.nonce,
      clientKeyId: client.identity.publicIdentity.keyId,
      clientNonce,
    })
    connection.socket.send(JSON.stringify({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      type: "client.hello",
      identity: client.identity.publicIdentity,
      nonce: clientNonce,
    }))

    const sessionTitle = `Encrypted integration ${crypto.randomUUID()}`
    await createOpenCodeSession(opencodePort, workspace, sessionTitle)
    const expectedSessions = await listOpenCodeSessions(opencodePort, workspace)
    const response = waitForSocketMessage(connection.socket)
    const request = await encryptRelayPayload({
      sender: client.identity,
      recipient: message.identity,
      payload: {
        protocolVersion: RELAY_PROTOCOL_VERSION,
        kind: "request",
        requestId: crypto.randomUUID(),
        sentAt: Date.now(),
        operation: "session.list",
        body: {},
      },
      epoch,
      sequence: 0,
    })
    const serializedRequest = JSON.stringify(request)
    assert.equal(serializedRequest.includes("session.list"), false)
    assert.equal(serializedRequest.includes(sessionTitle), false)
    connection.socket.send(serializedRequest)

    const serializedResponse = await withTimeout(
      response,
      10_000,
      "Timed out waiting for encrypted session.list response",
    )
    assert.equal(serializedResponse.includes("session.list"), false)
    assert.equal(serializedResponse.includes(sessionTitle), false)
    const responsePayload = await decryptRelayEnvelope({
      recipient: client.identity,
      sender: message.identity,
      envelope: JSON.parse(serializedResponse),
      epoch,
    })
    assert.equal(responsePayload.kind, "response")
    assert.equal(responsePayload.operation, "session.list")
    const responseBody = sessionListResponseBodySchema.parse(
      responsePayload.body,
    )
    assert.deepEqual(
      responseBody.sessions,
      expectedSessions.map((session) => ({
        id: session.id,
        ...(session.parentID ? { parentId: session.parentID } : {}),
        title: session.title,
        createdAt: session.time.created,
        updatedAt: session.time.updated,
      })),
    )
  } catch (error) {
    process.stderr.write(`\nOpenCode process output:\n${output}\n`)
    throw new Error(`OpenCode integration failed.\n\n${output}`, { cause: error })
  } finally {
    await stopProcess(opencode)
    for (const client of relay.clients) client.terminate()
    await closeRelay(relay)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

function waitForHello(relay) {
  return new Promise((resolve, reject) => {
    relay.on("connection", (socket) => {
      socket.once("message", (data) => {
        try {
          resolve({ message: JSON.parse(data.toString()), socket })
        } catch (error) {
          reject(error)
        }
      })
    })
  })
}

function waitForSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(data.toString()))
    socket.once("error", reject)
  })
}

async function waitForHealth(port, process) {
  const deadline = Date.now() + 10_000
  const url = `http://127.0.0.1:${port}/global/health`

  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`OpenCode exited before becoming healthy: ${process.exitCode}`)
    }

    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(500) })
    } catch {
      // OpenCode has not bound its port yet.
    }

    if (response?.ok) {
      const health = await response.json()
      if (health.healthy === true) {
        assert.equal(health.version, EXPECTED_OPENCODE_VERSION)
        return
      }
    }

    await delay(100)
  }

  throw new Error("Timed out waiting for OpenCode health")
}

async function activateWorkspace(port, workspace) {
  const url = new URL(`http://127.0.0.1:${port}/session`)
  url.searchParams.set("directory", workspace)
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  assert.equal(response.status, 200)
  const sessions = await response.json()
  assert.ok(Array.isArray(sessions))
}

async function createOpenCodeSession(port, workspace, title) {
  const url = sessionUrl(port, workspace)
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, 200)
  const session = await response.json()
  assert.equal(session.title, title)
}

async function listOpenCodeSessions(port, workspace) {
  const response = await fetch(sessionUrl(port, workspace), {
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, 200)
  const sessions = await response.json()
  assert.ok(Array.isArray(sessions))
  return sessions
}

function sessionUrl(port, workspace) {
  const url = new URL(`http://127.0.0.1:${port}/session`)
  url.searchParams.set("directory", workspace)
  return url
}

async function waitForSdkLog(readOutput, process) {
  const deadline = Date.now() + 5_000
  const expected = "Connected to local relay integration endpoint"

  while (Date.now() < deadline) {
    if (readOutput().includes(expected)) return
    if (process.exitCode !== null) {
      throw new Error(`OpenCode exited before writing plugin log: ${process.exitCode}`)
    }
    await delay(50)
  }

  throw new Error("Plugin did not write through the supplied OpenCode SDK client")
}

async function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

async function reservePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.notEqual(typeof address, "string")
  assert.ok(address)
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}

async function stopProcess(process) {
  if (process.exitCode !== null) return

  const gracefulExit = waitForProcessExit(process, 2_000)
  process.kill("SIGTERM")
  const stoppedGracefully = await gracefulExit
  if (stoppedGracefully) return

  const forcedExit = waitForProcessExit(process, 2_000)
  process.kill("SIGKILL")
  await forcedExit
  process.stdout.destroy()
  process.stderr.destroy()
  process.unref()
}

function waitForProcessExit(process, milliseconds) {
  if (process.exitCode !== null) return Promise.resolve(true)

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      process.off("exit", onExit)
      resolve(false)
    }, milliseconds)
    process.once("exit", onExit)
  })
}

function closeRelay(relay) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1_000)
    relay.close(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}
