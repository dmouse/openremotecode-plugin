import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { createOpencodeClient } from "@opencode-ai/sdk/client"
import { WebSocketServer } from "ws"
import {
  decryptRelayEnvelope,
  deriveRelayEpoch,
  encryptRelayPayload,
  generateConnectorIdentity,
  generateRelayNonce,
  RELAY_PROTOCOL_VERSION,
} from "@openremotecode/protocol"

export const OPENCODE_VERSION = "1.18.31"
const run = promisify(execFile)
const builtPlugin = fileURLToPath(new URL("../../dist/index.js", import.meta.url))

// Test-only instrumentation records synthetic session IDs and fixture paths in a
// disposable directory, never credentials, keys, messages, or process output.
const probe = `
import { appendFile } from "node:fs/promises"
import remote from ${JSON.stringify(pathToFileURL(builtPlugin).href)}
export default async (context) => {
  const record = (value) => appendFile(process.env.PROJECT_TEST_RECORDS,
    JSON.stringify({ directory: context.directory, ...value }) + "\\n")
  await record({ kind: "init", projectId: context.project.id, worktree: context.worktree })
  const hooks = await remote(context)
  return {
    ...hooks,
    event: async ({ event }) => {
      if (event.type.startsWith("session.")) {
        await record({ kind: "event", type: event.type,
          sessionId: event.properties?.info?.id ?? event.properties?.sessionID,
          status: event.properties?.status?.type })
      }
    },
    dispose: async () => {
      await hooks.dispose?.()
      await record({ kind: "dispose" })
    },
  }
}
`

export async function createProjectFixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-project-validation-"))
  let child
  let relay
  t.after(async () => {
    if (child) await stopProcess(child)
    if (relay) {
      for (const socket of relay.clients) socket.terminate()
      await new Promise((resolve) => relay.close(resolve))
    }
    await rm(root, { recursive: true, force: true })
  })
  const dirs = Object.fromEntries(["home", "config", "data", "cache", "state",
    "repo-a", "repo-b", "plain-a", "plain-b", "unopened"].map((name) => [name, path.join(root, name)]))
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))
  // Inherit executable discovery only, not provider credentials, OpenCode config,
  // production endpoints, or the developer's connector identity/data overrides.
  const env = {
    PATH: process.env.PATH,
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    PROJECT_TEST_RECORDS: path.join(root, "records.jsonl"),
  }
  await writeFile(env.GIT_CONFIG_GLOBAL, "")
  await writeFile(env.PROJECT_TEST_RECORDS, "")
  const git = (cwd, ...args) => run("git", args, { cwd, env, timeout: 10_000 })
  for (const name of ["repo-a", "repo-b"]) {
    await git(dirs[name], "init", "--initial-branch=main")
    await git(dirs[name], "-c", "user.name=Integration Fixture", "-c", "user.email=fixture@example.test",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", name)
  }
  dirs.worktree = path.join(root, "worktree-a")
  await git(dirs["repo-a"], "worktree", "add", "-b", "fixture", dirs.worktree)
  dirs.missing = path.join(root, "does-not-exist")
  dirs.file = path.join(root, "regular-file")
  await writeFile(dirs.file, "fixture")
  const probePath = path.join(root, "probe.mjs")
  await writeFile(probePath, probe)
  const mcpCommand = [process.execPath, fileURLToPath(new URL("./mcp-status-server.mjs", import.meta.url))]
  await mkdir(path.join(dirs.config, "opencode"))
  if (options.syntheticProviderURL && new URL(options.syntheticProviderURL).hostname !== "127.0.0.1") {
    throw new Error("Synthetic providers must be loopback only")
  }
  await writeFile(path.join(dirs.config, "opencode", "opencode.json"), JSON.stringify({
    share: "disabled",
    enabled_providers: options.syntheticProviderURL ? ["fixture"] : [],
    ...(options.syntheticProviderURL ? { provider: { fixture: {
      npm: "@ai-sdk/openai-compatible", name: "Synthetic fixture",
      options: { baseURL: options.syntheticProviderURL },
      models: { fixture: { name: "Fixture", limit: { context: 32000, output: 1024 } } },
    } } } : {}),
    plugin: [pathToFileURL(probePath).href],
    ...(options.mcpStatusFixture === true ? { mcp: {
      "connected-fixture": { type: "local", command: mcpCommand, enabled: true, timeout: 2000 },
      "disabled-fixture": { type: "local", command: mcpCommand, enabled: false },
      "failed-fixture": { type: "local", command: [process.execPath, "-e", "process.exit(1)"], timeout: 1000 },
    } } : {}),
  }))
  const localProbe = path.join(root, "project-config-probe.mjs")
  await writeFile(localProbe, `
    import { appendFile } from "node:fs/promises"
    export default async ({ directory }) => {
      await appendFile(process.env.PROJECT_TEST_RECORDS,
        JSON.stringify({ kind: "project-config", directory }) + "\\n")
      return {}
    }
  `)
  await writeFile(path.join(dirs["repo-b"], "opencode.json"), JSON.stringify({
    plugin: [pathToFileURL(localProbe).href],
  }))

  const clientIdentity = await generateConnectorIdentity()
  relay = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(relay, "listening")
  const connections = []
  relay.on("connection", (socket) => {
    socket.once("message", (data) => {
      const hello = JSON.parse(data.toString())
      const clientNonce = generateRelayNonce()
      void deriveRelayEpoch({
        connectorKeyId: hello.identity.keyId,
        connectorNonce: hello.nonce,
        clientKeyId: clientIdentity.identity.publicIdentity.keyId,
        clientNonce,
      }).then((epoch) => {
        socket.send(JSON.stringify({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          type: "client.hello",
          identity: clientIdentity.identity.publicIdentity,
          nonce: clientNonce,
        }))
        connections.push({ socket, hello, epoch })
      })
    })
  })
  env.OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK = "true"
  env.OPENCODE_REMOTE_RELAY_URL = `ws://127.0.0.1:${relay.address().port}`
  env.OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY = JSON.stringify(clientIdentity.identity.publicIdentity)
  if (options.authorization) {
    const store = path.join(dirs.data, "opencode-remote")
    await mkdir(store, { mode: 0o700 })
    await writeFile(path.join(store, "connector-identity.json"), JSON.stringify(options.identity), { mode: 0o600 })
    await writeFile(path.join(store, "connector-authorization.json"), JSON.stringify(options.authorization), { mode: 0o600 })
    delete env.OPENCODE_REMOTE_RELAY_URL
    delete env.OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY
    env.OPENCODE_REMOTE_SERVER_URL = options.authorization.serviceOrigin
  }
  const port = await reservePort()
  child = spawn(process.env.OPENCODE_TEST_BINARY || "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: dirs["repo-a"], env, stdio: "ignore" })
  let spawnError
  child.on("error", (error) => { spawnError = error })
  const origin = `http://127.0.0.1:${port}`
  await eventually(async () => {
    if (spawnError) throw new Error("Could not launch the isolated OpenCode executable")
    assert.equal(child.exitCode, null, "OpenCode exited before becoming healthy")
    const response = await fetch(`${origin}/global/health`, { signal: AbortSignal.timeout(500) })
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.version, OPENCODE_VERSION, `Set OPENCODE_TEST_BINARY to OpenCode ${OPENCODE_VERSION}`)
    assert.equal(health.healthy, true)
  })
  let sequence = 0
  return {
    root, dirs, origin, connections,
    client: (directory) => createOpencodeClient({ baseUrl: origin, directory,
      fetch: (request) => fetch(request, { signal: AbortSignal.timeout(10_000) }) }),
    async request(directory, route, { method = "GET", body, query = {} } = {}) {
      const url = new URL(route, origin)
      if (directory !== undefined) url.searchParams.set("directory", directory)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
      const response = await fetch(url, {
        method,
        ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      })
      const data = await response.json()
      return { status: response.status, data, headers: response.headers }
    },
    async records() {
      return (await readFile(env.PROJECT_TEST_RECORDS, "utf8")).split("\n")
        .filter(Boolean).map((line) => JSON.parse(line))
    },
    async remoteSessions(connection) {
      return this.remoteRequest(connection, "session.list", {})
    },
    remoteEvent(connection, subscriptionId) {
      return remotePayload(connection, clientIdentity.identity, (payload) =>
        payload.kind === "event" && payload.requestId === subscriptionId)
    },
    async remoteRequest(connection, operation, body, requestId = crypto.randomUUID()) {
      const request = await encryptRelayPayload({
        sender: clientIdentity.identity,
        recipient: connection.hello.identity,
        payload: { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "request", requestId,
          sentAt: Date.now(), operation, body },
        epoch: connection.epoch,
        sequence: sequence++,
      })
      const response = remotePayload(connection, clientIdentity.identity, (payload) =>
        payload.kind === "response" && payload.requestId === requestId)
      connection.socket.send(JSON.stringify(request))
      return response
    },
  }
}

// Updates can interleave with replies. Match decrypted correlation, not the
// next socket frame, without retaining a plaintext event history in the relay.
function remotePayload(connection, recipient, accept) {
  return new Promise((resolve, reject) => {
    const finish = (error, payload) => {
      clearTimeout(timer)
      connection.socket.off("message", message)
      connection.socket.off("close", closed)
      if (error) reject(error)
      else resolve(payload)
    }
    const closed = () => finish(new Error("Fixture relay closed"))
    const message = (data) => {
      void decryptRelayEnvelope({ recipient, sender: connection.hello.identity,
        envelope: JSON.parse(data.toString()), epoch: connection.epoch }).then((payload) => {
        if (accept(payload)) finish(undefined, payload)
      }, (error) => finish(error))
    }
    const timer = setTimeout(() => finish(new Error("Fixture relay response timed out")), 10_000)
    connection.socket.on("message", message)
    connection.socket.once("close", closed)
  })
}

export async function eventually(check, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let failure
  while (Date.now() < deadline) {
    try { return await check() } catch (error) { failure = error }
    await delay(50)
  }
  throw failure
}

async function reservePort() {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  const exited = once(child, "exit")
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000)
  child.kill("SIGTERM")
  try { await exited } finally { clearTimeout(timer) }
}
