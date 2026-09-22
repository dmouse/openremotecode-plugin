import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

import { WebSocketServer } from "ws"

import {
  CHAT_STREAM_CAPABILITIES,
  CONNECTOR_CREDENTIAL_CAPABILITIES,
  connectorHelloSchema,
  decryptRelayEnvelope,
  deriveRelayEpoch,
  encryptRelayPayload,
  generateConnectorIdentity,
  generateRelayNonce,
  RELAY_PROTOCOL_VERSION,
} from "@openremotecode/protocol"

import { setupV2Connector } from "../../dist/v2/setup.js"
import { OpenCodeV2ChatAdapter } from "../../dist/v2/chat-adapter.js"

// Runs the connector against a real OpenCode 2 server through the real v2 promise client. The
// plugin does not depend on any v2 package, so both are supplied from outside:
//   OPENCODE_V2_TEST_BINARY  an OpenCode 2 executable
//   OPENCODE_V2_CLIENT       path to @opencode/client's dist/promise/index.js
const binary = process.env.OPENCODE_V2_TEST_BINARY
const clientEntry = process.env.OPENCODE_V2_CLIENT
const skip = !binary || !clientEntry ? "set OPENCODE_V2_TEST_BINARY and OPENCODE_V2_CLIENT to run" : false

test("an OpenCode 2 TUI connector serves encrypted chat operations through the relay", { skip }, async (t) => {
  const { OpenCode } = await import(pathToFileURL(clientEntry).href)
  const root = await mkdtemp(path.join(tmpdir(), "opencode-v2-connector-"))
  const dirs = Object.fromEntries(["home", "config", "data", "cache", "state", "workspace"]
    .map((name) => [name, path.join(root, name)]))
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })))
  const workspace = await realpath(dirs.workspace)

  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(relay, "listening")
  const hello = new Promise((resolve, reject) => relay.on("connection", (socket) => {
    socket.once("message", (data) => { try { resolve({ message: JSON.parse(data.toString()), socket }) } catch (e) { reject(e) } })
  }))
  const client = await generateConnectorIdentity()

  const port = await new Promise((resolve) => {
    const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    probe.on("listening", () => { const { port: p } = probe.address(); probe.close(() => resolve(p)) })
  })
  let output = ""
  const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    env: { PATH: process.env.PATH, HOME: dirs.home, XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
      XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state, TMPDIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk) => { output += chunk })
  server.stderr.on("data", (chunk) => { output += chunk })

  const saved = { ...process.env }
  let cleanup
  t.after(async () => {
    await cleanup?.()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    server.kill("SIGKILL")
    for (const socket of relay.clients) socket.terminate()
    await new Promise((resolve) => relay.close(resolve))
    await rm(root, { recursive: true, force: true })
  })

  const deadline = Date.now() + 15_000
  while (!/server password (\S+)/.test(output)) {
    assert.ok(Date.now() < deadline && server.exitCode === null, `OpenCode 2 did not start:\n${output}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const password = /server password (\S+)/.exec(output)[1]
  const v2 = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })

  // The connector keeps its identity under XDG_DATA_HOME; keep this test's out of the developer's.
  Object.assign(process.env, {
    XDG_DATA_HOME: dirs.data,
    OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK: "true",
    OPENCODE_REMOTE_RELAY_URL: `ws://127.0.0.1:${relay.address().port}`,
    OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY: JSON.stringify(client.identity.publicIdentity),
  })
  const toasts = []
  cleanup = await setupV2Connector({
    options: {}, location: { directory: workspace }, client: v2,
    data: { location: { default: () => ({ directory: workspace }) } },
    ui: { toast: { show: (toast) => toasts.push(toast) } },
  })

  const connection = await Promise.race([hello, new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timed out waiting for connector hello")), 10_000))])
  const message = connectorHelloSchema.parse(connection.message)
  assert.deepEqual(message.capabilities, ["session.list", ...new OpenCodeV2ChatAdapter(v2, workspace).capabilities,
    ...CHAT_STREAM_CAPABILITIES, ...CONNECTOR_CREDENTIAL_CAPABILITIES], "advertises only what the v2 adapter implements")

  const clientNonce = generateRelayNonce()
  const epoch = await deriveRelayEpoch({ connectorKeyId: message.identity.keyId, connectorNonce: message.nonce,
    clientKeyId: client.identity.publicIdentity.keyId, clientNonce })
  connection.socket.send(JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, type: "client.hello",
    identity: client.identity.publicIdentity, nonce: clientNonce }))

  let sequence = 0
  const call = async (operation, body) => {
    const requestId = crypto.randomUUID()
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${operation}`)), 10_000)
      const listener = (data) => {
        void decryptRelayEnvelope({ recipient: client.identity, sender: message.identity,
          envelope: JSON.parse(data.toString()), epoch }).then((payload) => {
          if (payload.requestId !== requestId) return
          clearTimeout(timer); connection.socket.off("message", listener); resolve(payload)
        }, reject)
      }
      connection.socket.on("message", listener)
    })
    const request = await encryptRelayPayload({ sender: client.identity, recipient: message.identity,
      payload: { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "request", requestId, sentAt: Date.now(), operation, body },
      epoch, sequence: sequence++ })
    connection.socket.send(JSON.stringify(request))
    return reply
  }

  const projects = await call("project.list", { version: 1 })
  assert.equal(projects.kind, "response")
  assert.deepEqual(projects.body.projects.map((p) => p.path), [workspace])
  const projectId = projects.body.projects[0].id

  const created = await call("chat.create", { version: 1, projectId })
  assert.equal(created.kind, "response")
  const chatId = created.body.chat.id
  const listed = await call("chat.list", { version: 1, projectId })
  assert.deepEqual(listed.body.chats.map((chat) => chat.id), [chatId])
  assert.equal(listed.body.cursor, null)
  assert.deepEqual((await call("chat.get", { version: 1, projectId, sessionId: chatId })).body.chat, created.body.chat)

  const missing = await call("chat.get", { version: 1, projectId, sessionId: "ses_doesnotexist" })
  assert.equal(missing.body.code, "chat_not_found")
  const empty = await call("chat.snapshot", { version: 1, projectId, sessionId: chatId })
  assert.equal(empty.kind, "response")
  assert.deepEqual([empty.body.messages, empty.body.status, empty.body.cursor], [[], "idle", null])
  for (const [operation, body] of [["chat.snapshot", { sessionId: chatId, includeTodos: true }],
    ["chat.rename", { sessionId: chatId, title: "x" }]]) {
    const refused = await call(operation, { version: 1, projectId, ...body })
    assert.equal(refused.body.code, "unsupported_operation", `${operation} ${JSON.stringify(body)}`)
  }
  // Model availability itself is environment/network dependent (the local install's own
  // catalog, not the connector) and was observed to vary between otherwise-identical runs in
  // this sandbox; what the connector controls is a well-formed list when there is anything to
  // list, verified directly against the real model.list()/provider.get() pipeline in the unit
  // tests instead of asserting a specific catalog is present here.
  const models = await call("chat.models", { version: 1, projectId })
  assert.equal(models.kind, "response")
  assert.ok(Array.isArray(models.body.models))
  assert.ok(models.body.models.every((m) => m.providerName.length > 0 && m.modelID.length > 0 && m.modelName.length > 0))

  const withMode = await call("chat.prompt", { version: 1, projectId, sessionId: chatId, text: "hi", mode: "plan" })
  assert.equal(withMode.body.code, "unsupported_operation")
  const abort = await call("chat.abort", { version: 1, projectId, sessionId: chatId })
  assert.deepEqual(abort.body, { version: 1, accepted: true })

  // History: a conversation OpenCode itself stores, read back through the encrypted relay.
  const seed = await v2.session.get({ sessionID: chatId })
  const now = Date.now()
  const model = { id: "fixture-model", providerID: "fixture" }
  const messages = []
  for (let i = 0; i < 12; i++) {
    const n = String(i).padStart(2, "0")
    messages.push({ id: `msg_u${n}`, type: "user", time: { created: now + i * 10 }, text: `question ${i}` })
    if (i === 3) messages.push({ id: "msg_switch", type: "agent-switched", time: { created: now + i * 10 + 2 }, agent: "plan" })
    messages.push({ id: `msg_a${n}`, type: "assistant", agent: "build", model, finish: "stop",
      time: { created: now + i * 10 + 5, completed: now + i * 10 + 9 },
      content: [{ type: "reasoning", text: `thinking ${i}`, time: { created: now + i * 10 + 5, completed: now + i * 10 + 6 } },
        { type: "text", text: `answer ${i}` }] })
  }
  const imported = await v2.session.import({ info: { ...seed, id: "ses_imported0000000000000001", title: "Imported",
    time: { created: now, updated: now + 200 } }, messages })
  const first = await call("chat.snapshot", { version: 1, projectId, sessionId: imported.id })
  assert.equal(first.kind, "response")
  assert.equal(first.body.chat.title, "Imported")
  assert.deepEqual(first.body.messages.map((m) => m.id).slice(-2), ["msg_u11", "msg_a11"], "newest last")
  assert.equal(first.body.messages.length, 10)
  assert.equal(first.body.messages.at(-1).text, "answer 11\n")
  assert.deepEqual(first.body.messages.at(-1).parts.map((p) => p.type), ["reasoning", "text"])
  assert.equal(first.body.messages.at(-1).mode, "build")
  assert.deepEqual(first.body.model, { providerID: "fixture", modelID: "fixture-model" })
  assert.equal(first.body.status, "idle")
  const seen = [...first.body.messages.map((m) => m.id)]
  let cursor = first.body.cursor
  while (cursor) {
    const older = await call("chat.snapshot", { version: 1, projectId, sessionId: imported.id, cursor })
    assert.equal(older.kind, "response")
    assert.equal("model" in older.body, false)
    seen.unshift(...older.body.messages.map((m) => m.id))
    cursor = older.body.cursor
    assert.ok(seen.length <= 40, "history paging must terminate")
  }
  assert.deepEqual(seen, Array.from({ length: 12 }, (_, i) => [`msg_u${String(i).padStart(2, "0")}`, `msg_a${String(i).padStart(2, "0")}`]).flat(),
    "every chat message exactly once, oldest first, bookkeeping messages skipped")
  const both = await call("chat.list", { version: 1, projectId })
  assert.deepEqual(both.body.chats.map((c) => c.id).sort(), [chatId, imported.id].sort())

  // Tool and shell content: imported alongside the history above, read back with each opt-in.
  const toolSeed = await v2.session.import({ info: { ...seed, id: "ses_tools00000000000000001", title: "Tools",
      time: { created: now, updated: now + 10 } },
    messages: [
      { id: "msg_u_tool", type: "user", time: { created: now }, text: "run it" },
      { id: "msg_a_tool", type: "assistant", agent: "build", model, finish: "stop", time: { created: now + 1, completed: now + 5 },
        content: [
          { id: "read1", type: "tool", name: "read", time: { created: now + 1, completed: now + 2 },
            state: { status: "completed", input: { filePath: "/x/a.dart" }, content: [{ type: "text", text: "file body" }] } },
          { id: "bash1", type: "tool", name: "bash", time: { created: now + 2, ran: now + 2, completed: now + 4 },
            state: { status: "completed", input: { command: "ls -la", description: "list files" }, content: [{ type: "text", text: "a.dart" }] } },
          { type: "text", text: "done" },
        ] },
    ] })
  const plain = await call("chat.snapshot", { version: 1, projectId, sessionId: toolSeed.id })
  assert.equal("parts" in plain.body.messages[1], false)
  const withTools = await call("chat.snapshot", { version: 1, projectId, sessionId: toolSeed.id, includeTools: true })
  assert.equal(withTools.body.messages[1].parts[0].tool.operation, "read")
  assert.equal(withTools.body.messages[1].parts[0].tool.description, "a.dart")
  assert.equal("shell" in withTools.body.messages[1].parts[1].tool, false)
  const withShell = await call("chat.snapshot", { version: 1, projectId, sessionId: toolSeed.id, includeTools: true, includeShell: true })
  assert.deepEqual(withShell.body.messages[1].parts[1].tool.shell, { command: "ls -la", output: "a.dart", truncated: false })
  assert.equal(withShell.body.messages[1].parts.at(-1).text, "done\n")

  // Streaming: subscribe, observe the initial update, rename the chat live, and see the update
  // arrive over the relay without a fresh request -- across the real v2 event stream.
  const subscriptionId = crypto.randomUUID()
  const updates = []
  const unsubscribeFromUpdates = ((listener) => { connection.socket.on("message", listener); return () => connection.socket.off("message", listener) })(
    (data) => { void decryptRelayEnvelope({ recipient: client.identity, sender: message.identity, envelope: JSON.parse(data.toString()), epoch })
      .then((payload) => { if (payload.kind === "event" && payload.operation === "chat.stream.updated") updates.push(payload.body) }, () => {}) })
  const subscribed = await call("chat.stream.subscribe", { version: 1, projectId, sessionId: chatId, subscriptionId })
  assert.equal(subscribed.kind, "response")
  assert.equal(subscribed.body.snapshot.chat.id, chatId)
  assert.equal(subscribed.body.reset, false)
  await v2.session.update({ sessionID: chatId, title: "Renamed live" })
  const streamDeadline = Date.now() + 10_000
  while (!updates.some((update) => update.snapshot.chat.title === "Renamed live")) {
    assert.ok(Date.now() < streamDeadline, "Timed out waiting for a live chat.stream.updated")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  unsubscribeFromUpdates()
  const unsubscribed = await call("chat.stream.unsubscribe", { version: 1, projectId, sessionId: chatId, subscriptionId })
  assert.deepEqual(unsubscribed.body, { version: 1, unsubscribed: true })

  // Questions: a real Form on the real server, shaped the way OpenCode 2's own question tool is
  // believed to ask (one multiselect/string field per question) -- see ADR 0013 for what is and
  // isn't confirmed about that shape. No question is pending until the client opts in.
  const noneYet = await call("chat.snapshot", { version: 1, projectId, sessionId: chatId, includeQuestions: true })
  assert.equal(noneYet.body.question, null)
  const questionForm = await v2.session.form.create({ sessionID: chatId, title: "Questions", fields: [
    { key: "q0", type: "multiselect", title: "Which approach?",
      options: [{ value: "opt-fast", label: "Fast" }, { value: "opt-thorough", label: "Thorough", description: "slower" }] },
    { key: "q1", type: "string", title: "Anything else to consider?", options: [{ value: "no", label: "No" }], custom: true },
  ] })
  const withQuestion = await call("chat.snapshot", { version: 1, projectId, sessionId: chatId, includeQuestions: true })
  assert.equal(withQuestion.body.question.id, questionForm.id)
  assert.deepEqual(withQuestion.body.question.questions, [
    { header: "", question: "Which approach?", multiple: true, custom: false,
      options: [{ label: "Fast" }, { label: "Thorough", description: "slower" }] },
    { header: "", question: "Anything else to consider?", multiple: false, custom: true, options: [{ label: "No" }] },
  ])
  const answered = await call("chat.question.reply", { version: 1, projectId, sessionId: chatId, questionId: questionForm.id,
    response: "answer", answers: [{ selected: [1] }, { text: "nothing else" }] })
  assert.deepEqual(answered.body, { version: 1, accepted: true })
  const formAfter = await v2.session.form.get({ sessionID: chatId, formID: questionForm.id })
  assert.deepEqual(formAfter.state, { status: "answered", answer: { q0: ["opt-thorough"], q1: "nothing else" } })
  const goneAfterAnswer = await call("chat.snapshot", { version: 1, projectId, sessionId: chatId, includeQuestions: true })
  assert.equal(goneAfterAnswer.body.question, null, "an answered form is no longer pending")
  const staleReply = await call("chat.question.reply", { version: 1, projectId, sessionId: chatId, questionId: questionForm.id,
    response: "reject" })
  assert.equal(staleReply.body.code, "context_expired", "an already-answered form cannot be replied to again")

  const rejectForm = await v2.session.form.create({ sessionID: chatId, title: "Q2",
    fields: [{ key: "q0", type: "multiselect", title: "Pick one", options: [{ value: "x", label: "X" }] }] })
  const rejected = await call("chat.question.reply", { version: 1, projectId, sessionId: chatId, questionId: rejectForm.id, response: "reject" })
  assert.deepEqual(rejected.body, { version: 1, accepted: true })
  const rejectFormAfter = await v2.session.form.get({ sessionID: chatId, formID: rejectForm.id })
  assert.equal(rejectFormAfter.state.status, "cancelled")

  // A form outside the recognized question shape (here: a boolean field) is never surfaced.
  await v2.session.form.create({ sessionID: chatId, title: "Settings",
    fields: [{ key: "confirm", type: "boolean", title: "Enable?" }] })
  const unrecognized = await call("chat.snapshot", { version: 1, projectId, sessionId: chatId, includeQuestions: true })
  assert.equal(unrecognized.body.question, null)

  // Subtasks: a real child session (info.parentID set, since v2's client API has no direct
  // "create a child" call -- only the task tool creates one during a real agent run, which this
  // environment cannot do) and a parent message with a "task" tool call believed to link to it
  // the same way v1's does. See ADR 0013.
  const childNow = Date.now()
  // The parent (whose message holds the task tool call) must exist before a child can import
  // with a parentID referencing it -- the server validates the reference at import time.
  const taskSeed = await v2.session.import({ info: { ...seed, id: "ses_task0000000000000000001", title: "Task",
      time: { created: childNow, updated: childNow + 6 } },
    messages: [
      { id: "msg_tu0", type: "user", time: { created: childNow }, text: "please investigate" },
      { id: "msg_ta0", type: "assistant", agent: "build", model, finish: "stop", time: { created: childNow + 1, completed: childNow + 6 },
        content: [{ id: "task1", type: "tool", name: "task", time: { created: childNow + 1, completed: childNow + 6 },
          // A fixed literal id, not child.id -- child is imported next, referencing taskSeed.id
          // as its own parentID, so the two imports can't be sequenced the other way around.
          state: { status: "completed", input: { description: "Investigate the bug", subagent_type: "general" },
            content: [{ type: "text", text: "done" }], metadata: { sessionId: "ses_child00000000000000001" } } }] },
    ] })
  const child = await v2.session.import({ info: { ...seed, id: "ses_child00000000000000001", title: "Investigate the bug",
      parentID: taskSeed.id, time: { created: childNow, updated: childNow + 5 } },
    messages: [
      { id: "msg_cu0", type: "user", time: { created: childNow }, text: "go investigate" },
      { id: "msg_ca0", type: "assistant", agent: "general", model, finish: "stop", time: { created: childNow + 1, completed: childNow + 5 },
        content: [{ type: "text", text: "found it" }] },
    ] })
  const plainTask = await call("chat.snapshot", { version: 1, projectId, sessionId: taskSeed.id })
  assert.equal("parts" in plainTask.body.messages[1], false)
  const withSubtasks = await call("chat.snapshot", { version: 1, projectId, sessionId: taskSeed.id, includeSubtasks: true })
  const subtaskPart = withSubtasks.body.messages[1].parts[0]
  assert.equal(subtaskPart.type, "subtask")
  assert.equal(subtaskPart.task.title, "Investigate the bug")
  assert.equal(subtaskPart.task.agent, "general")
  assert.equal(subtaskPart.task.sessionId, child.id, "resolves the real linked child, not a degraded fallback")
  assert.equal(subtaskPart.task.status, "completed")
  assert.deepEqual(subtaskPart.task.stats, { toolCalls: 0, complete: true, durationMs: 5 })
  const subtaskView = await call("chat.subtask.snapshot", { version: 1, projectId, sessionId: child.id, parentSessionId: taskSeed.id })
  assert.equal(subtaskView.body.chat.parentId, taskSeed.id)
  assert.deepEqual(subtaskView.body.messages.map((m) => m.role), ["user", "assistant"])
  const wrongParent = await call("chat.subtask.snapshot", { version: 1, projectId, sessionId: child.id, parentSessionId: chatId })
  assert.equal(wrongParent.body.code, "access_denied")

  // Activities and images: a real inline PNG attachment (a 2x2 red pixel) and a real completed
  // tool call, read back through the encrypted relay only when the client opts in.
  const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg=="
  const mediaNow = Date.now()
  const mediaSeed = await v2.session.import({ info: { ...seed, id: "ses_media0000000000000001", title: "Media",
      time: { created: mediaNow, updated: mediaNow + 3 } },
    messages: [
      { id: "msg_mu0", type: "user", time: { created: mediaNow }, text: "look at this",
        files: [{ name: "pixel.png", mime: "image/png", data: TINY_PNG_BASE64, source: { type: "inline" } }] },
      { id: "msg_ma0", type: "assistant", agent: "build", model, finish: "stop", time: { created: mediaNow + 1, completed: mediaNow + 2 },
        content: [{ id: "read1", type: "tool", name: "read", time: { created: mediaNow + 1, completed: mediaNow + 2 },
          state: { status: "completed", input: { filePath: "/x/a.dart" }, content: [{ type: "text", text: "body" }] } }] },
    ] })
  const plainMedia = await call("chat.snapshot", { version: 1, projectId, sessionId: mediaSeed.id })
  assert.equal("parts" in plainMedia.body.messages[0], false, "images are only decoded when the client opts in")
  const withImages = await call("chat.snapshot", { version: 1, projectId, sessionId: mediaSeed.id, includeImages: true })
  const imagePart = withImages.body.messages[0].parts.find((p) => p.type === "image")
  assert.ok(imagePart, "the real png decoded into a bounded image preview")
  assert.equal(imagePart.image.mime, "image/jpeg")
  assert.ok(imagePart.image.data.length > 0)
  const withActivities = await call("chat.snapshot", { version: 1, projectId, sessionId: mediaSeed.id,
    includeTools: true, includeActivities: true })
  const toolPart = withActivities.body.messages[1].parts[0]
  assert.equal(toolPart.activity.kind, "read")
  assert.equal(toolPart.activity.state, "completed")

  // Pairing is skipped on the development relay path, so nothing was shown to the user.
  assert.deepEqual(toasts, [])
})
