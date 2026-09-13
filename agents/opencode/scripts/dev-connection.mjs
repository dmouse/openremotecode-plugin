import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { WebSocketServer } from "ws"

import {
  connectorHelloSchema,
  decryptRelayEnvelope,
  encryptRelayPayload,
  generateConnectorIdentity,
  sessionListResponseBodySchema,
} from "@openremotecode/protocol"

const EXPECTED_OPENCODE_VERSION = "1.18.30"
const opencodeBinary = process.env.OPENCODE_TEST_BINARY || "opencode"
const pluginRoot = fileURLToPath(new URL("../", import.meta.url))
const repositoryRoot = path.dirname(pluginRoot)
const temporaryRoot = await mkdtemp(
  path.join(tmpdir(), "opencode-remote-demo-"),
)
const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 })
const relayListening = once(relay, "listening")
let opencode
let output = ""

try {
  const directories = Object.fromEntries(
    ["home", "config", "data", "cache"].map((name) => [
      name,
      path.join(temporaryRoot, name),
    ]),
  )
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  )

  await relayListening
  const relayAddress = relay.address()
  assert.notEqual(typeof relayAddress, "string")
  assert.ok(relayAddress)
  const relayUrl = `ws://127.0.0.1:${relayAddress.port}`
  const client = await generateConnectorIdentity()
  const connector = waitForConnector(relay)
  const opencodePort = await reservePort()

  print(`local relay listening at ${relayUrl}`)
  print("launching a real OpenCode server with the root opencode.json")
  opencode = spawn(
    opencodeBinary,
    [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(opencodePort),
      "--print-logs",
      "--log-level",
      "INFO",
    ],
    {
      cwd: repositoryRoot,
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
        OPENCODE_REMOTE_RELAY_URL: relayUrl,
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

  const health = await waitForHealth(opencodePort, opencode)
  assert.equal(health.version, EXPECTED_OPENCODE_VERSION)
  print(`OpenCode ${health.version} is healthy`)

  const title = "Open Remote Code connection demo"
  const createdSession = await createOpenCodeSession(
    opencodePort,
    repositoryRoot,
    title,
  )
  print(`created real session ${createdSession.id}`)

  const connection = await withTimeout(
    connector,
    10_000,
    "timed out waiting for the plugin connection",
  )
  const hello = connectorHelloSchema.parse(connection.message)
  assert.ok(hello.capabilities.includes("session.list"))
  print(`plugin connected as ${hello.identity.keyId.slice(0, 12)}...`)
  print(`negotiated capabilities: ${hello.capabilities.join(", ")}`)

  const requestId = crypto.randomUUID()
  const request = await encryptRelayPayload({
    sender: client.identity,
    recipient: hello.identity,
    payload: {
      protocolVersion: 1,
      kind: "request",
      requestId,
      sentAt: Date.now(),
      operation: "session.list",
      body: {},
    },
    sequence: 0,
  })
  const serializedRequest = JSON.stringify(request)
  assert.equal(serializedRequest.includes("session.list"), false)
  assert.equal(serializedRequest.includes(title), false)

  const responseMessage = waitForSocketMessage(connection.socket)
  connection.socket.send(serializedRequest)
  print("client sent encrypted session.list request")
  const serializedResponse = await withTimeout(
    responseMessage,
    10_000,
    "timed out waiting for the encrypted plugin response",
  )
  assert.equal(serializedResponse.includes("session.list"), false)
  assert.equal(serializedResponse.includes(title), false)

  const response = await decryptRelayEnvelope({
    recipient: client.identity,
    sender: hello.identity,
    envelope: JSON.parse(serializedResponse),
  })
  assert.equal(response.kind, "response")
  assert.equal(response.requestId, requestId)
  assert.equal(response.operation, "session.list")
  const body = sessionListResponseBodySchema.parse(response.body)
  assert.ok(
    body.sessions.some(
      (session) =>
        session.id === createdSession.id && session.title === createdSession.title,
    ),
  )

  print(`client decrypted ${body.sessions.length} session(s):`)
  for (const session of body.sessions) {
    process.stdout.write(`  - ${session.title} (${session.id})\n`)
  }
  print("connection demo passed; relay observed ciphertext only")
} catch (error) {
  process.stderr.write(
    `[connection-demo] failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  if (output) process.stderr.write(`\nOpenCode output:\n${output}\n`)
  process.exitCode = 1
} finally {
  if (opencode) await stopProcess(opencode)
  for (const socket of relay.clients) socket.terminate()
  await closeRelay(relay)
  await rm(temporaryRoot, { recursive: true, force: true })
}

function print(message) {
  process.stdout.write(`[connection-demo] ${message}\n`)
}

function waitForConnector(server) {
  return new Promise((resolve, reject) => {
    server.once("connection", (socket) => {
      socket.once("message", (data) => {
        try {
          resolve({ message: JSON.parse(data.toString()), socket })
        } catch (error) {
          reject(error)
        }
      })
      socket.once("error", reject)
    })
    server.once("error", reject)
  })
}

function waitForSocketMessage(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("message", onMessage)
      socket.off("error", onError)
      socket.off("close", onClose)
    }
    const onMessage = (data) => {
      cleanup()
      resolve(data.toString())
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error("plugin connection closed before responding"))
    }
    socket.once("message", onMessage)
    socket.once("error", onError)
    socket.once("close", onClose)
  })
}

async function waitForHealth(port, process) {
  const deadline = Date.now() + 10_000
  const url = `http://127.0.0.1:${port}/global/health`

  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`OpenCode exited with code ${process.exitCode}`)
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        const health = await response.json()
        if (health.healthy === true) return health
      }
    } catch {
      // OpenCode has not bound its port yet.
    }
    await delay(100)
  }

  throw new Error("timed out waiting for OpenCode health")
}

async function createOpenCodeSession(port, directory, title) {
  const url = new URL(`http://127.0.0.1:${port}/session`)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`OpenCode session creation failed with ${response.status}`)
  }
  return response.json()
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
  if (await gracefulExit) return

  const forcedExit = waitForProcessExit(process, 2_000)
  process.kill("SIGKILL")
  await forcedExit
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

function closeRelay(server) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1_000)
    server.close(() => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

function withTimeout(promise, milliseconds, message) {
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
