import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { chatStreamUpdateSchema } from "@openremotecode/protocol"
import { createProjectFixture, eventually } from "../support/opencode-project-fixture.mjs"
import { openCodeEvents } from "../../dist/opencode-events.js"

// The health check only confirms the HTTP server is accepting connections; the
// SSE /event route can still race the session/plugin bootstrap immediately
// after createProjectFixture returns, so retry the handshake like eventually()
// already does for health.
async function connectAgentEvents(client, directory) {
  return eventually(async () => {
    const observation = new AbortController()
    const observed = new Set()
    let ready
    const connected = new Promise((resolve) => { ready = resolve })
    const observing = (async () => {
      for await (const event of openCodeEvents(client, directory, observation.signal)) {
        observed.add(event.type)
        if (event.type === "server.connected") ready()
      }
    })()
    const failure = observing.then(() => { throw new Error("Agent event stream ended before connecting") })
    let timer
    try {
      await Promise.race([connected, failure, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Agent event connection attempt timed out")), 3000)
      })])
      return { observation, observed, observing }
    } catch (error) {
      observation.abort()
      await observing.catch(() => {})
      throw error
    } finally {
      clearTimeout(timer)
    }
  }, 10_000)
}

test("native running output and completion arrive as encrypted activity updates without polling", async (t) => {
  const f = await createProjectFixture(t)
  const client = f.client(f.dirs["repo-a"])
  const session = (await client.session.create({ body: { title: "Live shell" } })).data
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  const projects = await f.remoteRequest(connection, "project.list", { version: 1 })
  const target = { version: 1, projectId: projects.body.projects[0].id, sessionId: session.id,
    subscriptionId: crypto.randomUUID(), includeTools: true, includeShell: true, includeActivities: true }
  const baseline = await f.remoteRequest(connection, "chat.stream.subscribe", target)
  assert.equal(baseline.operation, "chat.stream.subscribe")
  chatStreamUpdateSchema.parse(baseline.body)
  // Attach before local execution. remoteEvent filters interleaved request replies.
  const first = f.remoteEvent(connection, target.subscriptionId)
  const execution = client.session.shell({ path: { id: session.id }, body: {
    agent: "build", model: { providerID: "fixture", modelID: "fixture" },
    command: "printf 'first\\n'; sleep 2; printf 'last\\n'",
  } })
  let update = await first
  const deadline = Date.now() + 10000
  let running = false, completed = false, lastRevision = baseline.body.revision
  while (Date.now() < deadline) {
    chatStreamUpdateSchema.parse(update.body)
    assert.ok(update.body.revision > lastRevision)
    lastRevision = update.body.revision
    for (const message of update.body.snapshot.messages) for (const part of message.parts ?? []) {
      if (part.activity?.kind === "execute") {
        running ||= part.activity.state === "running" && part.tool.shell.output.includes("first")
        completed ||= part.activity.state === "completed" && part.tool.shell.output.includes("last")
      }
    }
    if (completed) break
    update = await f.remoteEvent(connection, target.subscriptionId)
  }
  const executed = await execution
  assert.equal(running, true)
  assert.equal(completed, true)
  // Exercise actual native text-part events without a model/provider dependency.
  // Replacement chunks must produce the current text, never duplicate appends.
  const part = { id: `prt_${crypto.randomUUID().replaceAll('-', '')}`, sessionID: session.id,
    messageID: executed.data.info.id, type: "text", text: "" }
  for (const text of ["Hello", "Hello from a live agent"]) {
    const next = f.remoteEvent(connection, target.subscriptionId)
    const result = await f.request(f.dirs["repo-a"], `/session/${session.id}/message/${part.messageID}/part/${part.id}`,
      { method: "PATCH", body: { ...part, text } })
    assert.equal(result.status, 200)
    let event = await next
    while (!event.body.snapshot.messages.some((m) => m.text.includes(text))) {
      event = await f.remoteEvent(connection, target.subscriptionId)
    }
    const message = event.body.snapshot.messages.find((m) => m.id === part.messageID)
    assert.equal(message.parts.find((p) => p.id === part.id).text, `${text}\n`)
  }
  const foreign = (await f.client(f.dirs["repo-b"]).session.create({ body: { title: "Foreign stream" } })).data
  const denied = await f.remoteRequest(connection, "chat.stream.subscribe", { ...target,
    subscriptionId: crypto.randomUUID(), sessionId: foreign.id })
  assert.ok(["access_denied", "context_expired"].includes(denied.body.code))
  const { includeTools: _includeTools, includeShell: _includeShell, includeActivities: _includeActivities, ...stop } = target
  assert.equal((await f.remoteRequest(connection, "chat.stream.unsubscribe", stop)).body.unsubscribed, true)
})

for (const engine of ["legacy", "next"]) test(`1.18.30 ${engine} provider reasoning and text stream before generation completes`, async (t) => {
  let finished = false
  let firstChunkAt = 0, firstThinkingLatency
  const provider = createServer(async (request, response) => {
    // Test data only. Drain prompts without logging or retaining their content.
    request.resume()
    response.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`)
    if (!firstChunkAt) firstChunkAt = performance.now()
    chunk({ reasoning_content: "Inspecting" })
    const reasoningTimer = setTimeout(() => chunk({ reasoning_content: " the fixture" }), 400)
    const textTimer = setTimeout(() => chunk({ content: "Streaming" }), 900)
    const timer = setTimeout(() => {
      chunk({ content: " answer" }, "stop")
      finished = true
      response.end("data: [DONE]\n\n")
    }, 3000)
    response.on("close", () => { clearTimeout(reasoningTimer); clearTimeout(textTimer); clearTimeout(timer) })
  })
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  t.after(() => { provider.closeAllConnections(); provider.close() })
  const f = await createProjectFixture(t, { syntheticProviderURL: `http://127.0.0.1:${provider.address().port}/v1` })
  const client = f.client(f.dirs["repo-a"])
  await client.project.current()
  const session = engine === "legacy" ? (await client.session.create({ body: { title: "Provider streaming fixture" } })).data
    : (await f.request(undefined, "/api/session", { method: "POST", body: {
      agent: "build", model: { id: "fixture", providerID: "fixture" }, location: { directory: f.dirs["repo-a"] },
    } })).data.data
  if (engine === "legacy") await client.session.prompt({ path: { id: session.id }, body: { noReply: true,
    model: { providerID: "fixture", modelID: "fixture" }, parts: [{ type: "text", text: "Synthetic context" }] } })
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  const projectId = (await f.remoteRequest(connection, "project.list", { version: 1 })).body.projects[0].id
  const target = { version: 1, projectId, sessionId: session.id, subscriptionId: crypto.randomUUID(), includeActivities: true }
  await f.remoteRequest(connection, "chat.stream.subscribe", target)
  const { observation, observed, observing } = await connectAgentEvents(client, f.dirs["repo-a"])
  // observing only feeds the diagnostic `observed` assertion below; the connection can
  // legitimately close on its own before cleanup (seen in CI). Attach a handler now so
  // that later rejection is never unhandled — a real miss still fails via `observed`.
  const observingSettled = observing.catch((error) => error)
  t.after(async () => { observation.abort(); await observingSettled })
  let next = f.remoteEvent(connection, target.subscriptionId)
  if (engine === "legacy") {
    const prompt = await f.remoteRequest(connection, "chat.prompt", { version: 1, projectId, sessionId: session.id, text: "Reply with a short fixture" })
    assert.equal(prompt.body.accepted, true)
  } else {
    const prompt = await f.request(f.dirs["repo-a"], `/api/session/${session.id}/prompt`, {
      method: "POST", body: { prompt: { text: "Reply with a short fixture" } },
    })
    assert.equal(prompt.status, 200)
  }
  let sawPartial = false, sawFinal = false, sawThinking = false, sawThought = false
  const thoughts = new Set()
  while (!sawFinal) {
    const event = await next
    for (const message of event.body.snapshot.messages) {
      if (message.role !== "assistant") continue
      for (const part of message.parts ?? []) if (part.type === "reasoning") {
        if (part.activity?.state === "running") {
          firstThinkingLatency ??= performance.now() - firstChunkAt
          sawThinking = true
          thoughts.add(part.text)
          assert.equal(finished, false)
          assert.equal(event.body.snapshot.status, "busy")
        }
        sawThought ||= part.activity?.state === "completed"
      }
      if (message.text === "Streaming\n") { assert.equal(finished, false); sawPartial = true }
      if (message.text === "Streaming answer\n") sawFinal = true
    }
    if (!sawFinal) next = f.remoteEvent(connection, target.subscriptionId)
  }
  assert.equal(sawPartial, true)
  assert.equal(sawThinking, true)
  assert.ok(thoughts.size >= 2)
  assert.equal(sawThought, true)
  assert.ok(firstThinkingLatency < 1000, 'A local live update must not wait for full generation or snapshot enrichment')
  t.diagnostic(`${engine} first reasoning update: ${Math.round(firstThinkingLatency)}ms`)
  if (engine === "next") assert.ok(observed.has("session.next.reasoning.started"), 'Must exercise the actual next engine')
  const reconciled = await f.remoteRequest(connection, "chat.snapshot", { version: 1, projectId,
    sessionId: session.id, includeActivities: true })
  assert.ok(reconciled.body.messages.some((m) => m.text === "Streaming answer\n"))
})

test("native mixed-engine history paginates both stores without losing a partial page", async (t) => {
  const f = await createProjectFixture(t)
  const client = f.client(f.dirs['repo-a'])
  const session = (await client.session.create({ body: { title: 'Mixed history fixture' } })).data
  const ids = new Set()
  for (let i = 0; i < 6; i++) {
    const result = await client.session.prompt({ path: { id: session.id }, body: { noReply: true,
      model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: `Legacy ${i}` }] } })
    ids.add(result.data.info.id)
  }
  const db = new DatabaseSync(path.join(f.dirs.data, 'opencode', 'opencode.db'))
  try {
    for (let i = 0; i < 14; i++) {
      const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`
      ids.add(id)
      const data = { time: { created: 1000 + i, completed: 1001 + i }, agent: 'build',
        model: { id: 'fixture', providerID: 'fixture' }, content: [{ id: 'text-0', type: 'text', text: `Next ${i}` }], finish: 'stop' }
      db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, session.id, 'assistant', i + 1, 1000 + i, 1000 + i, JSON.stringify(data))
    }
  } finally { db.close() }
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  const projectId = (await f.remoteRequest(connection, 'project.list', { version: 1 })).body.projects[0].id
  const found = []
  let cursor
  do {
    const response = await f.remoteRequest(connection, 'chat.snapshot', { version: 1, projectId, sessionId: session.id, ...(cursor ? { cursor } : {}) })
    assert.equal(response.operation, 'chat.snapshot')
    found.push(...response.body.messages.map((m) => m.id))
    cursor = response.body.cursor
    assert.ok(found.length <= 20)
  } while (cursor)
  assert.equal(found.length, 20)
  assert.deepEqual(new Set(found), ids)
})
