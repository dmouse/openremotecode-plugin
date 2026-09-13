import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { chatResponses } from "@openremotecode/protocol"
import { createProjectFixture, eventually } from "../support/opencode-project-fixture.mjs"

test("file expansion stays local while opt-in tools reach encrypted snapshots", async (t) => {
  const f = await createProjectFixture(t)
  const client = f.client(f.dirs["repo-a"])
  const session = (await client.session.create({ body: { title: "Tool fixture" } })).data
  // Data-file expansion exercises native synthetic parts without requiring a
  // configured model for OpenCode's file:// Read tool path or calling a provider.
  const url = `data:text/plain;base64,${Buffer.from("PRIVATE_ATTACHMENT_CONTENT\n".repeat(2000)).toString("base64")}`
  const user = (await client.session.prompt({ path: { id: session.id }, body: {
    noReply: true, model: { providerID: "fixture", modelID: "fixture" },
    parts: [{ type: "text", text: "Review @example.txt" },
      { type: "file", filename: "example.txt", mime: "text/plain", url }],
  } })).data
  assert.ok(user.parts.some((p) => p.type === "text" && p.synthetic && p.text.includes("PRIVATE_ATTACHMENT_CONTENT")))
  const fixture = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-tools-v1.json", import.meta.url), "utf8"))
  const now = Date.now(), messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`
  const db = new DatabaseSync(path.join(f.dirs.data, "opencode", "opencode.db"))
  try {
    const data = { role: "assistant", parentID: user.info.id,
      time: { created: now, completed: now }, modelID: "fixture", providerID: "fixture",
      mode: "build", agent: "build", path: { cwd: f.dirs["repo-a"], root: f.dirs["repo-a"] }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
      .run(messageId, session.id, now, now, JSON.stringify(data))
    for (const [index, part] of fixture.nativeParts.entries()) {
      if (index === 0) part.state.input.filePath = path.join(f.dirs["repo-a"], "lib/example.dart")
      part.callID = `call_${index}`
      if (part.state.status === "completed") part.state.title = "Read"
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(`prt_${messageId.slice(4)}_${index}`, messageId, session.id, now, now, JSON.stringify(part))
    }
  } finally { db.close() }
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  const projects = await f.remoteRequest(connection, "project.list", { version: 1 })
  const request = { version: 1, projectId: projects.body.projects[0].id, sessionId: session.id }
  for (const includeTools of [undefined, false, true]) {
    const response = await f.remoteRequest(connection, "chat.snapshot", { ...request,
      ...(includeTools !== undefined ? { includeTools } : {}) })
    chatResponses["chat.snapshot"].parse(response.body)
    const visibleUser = response.body.messages.find((m) => m.id === user.info.id)
    assert.equal(visibleUser.text, "Review @example.txt\n[File: example.txt]\n")
    const message = response.body.messages.find((m) => m.id === messageId)
    assert.equal(message.text, fixture.response.messages[0].text)
    if (includeTools) {
      assert.deepEqual(message.parts.map((p) => p.tool), fixture.response.messages[0].parts.map((p) => p.tool))
    } else assert.equal(message.parts, undefined)
    assert.equal(JSON.stringify(response.body).includes("PRIVATE_"), false)
  }
  const marker = await f.remoteRequest(connection, "chat.tools", { version: 1 })
  assert.equal(marker.body.code, "unsupported_operation")
  const foreign = (await f.client(f.dirs["repo-b"]).session.create({ body: { title: "Foreign" } })).data
  const denied = await f.remoteRequest(connection, "chat.snapshot", { ...request, sessionId: foreign.id, includeTools: true })
  assert.equal(denied.body.code, "access_denied")
})

test("native shell command and output cross encrypted snapshots only when negotiated", async (t) => {
  const f = await createProjectFixture(t)
  const client = f.client(f.dirs["repo-a"])
  const session = (await client.session.create({ body: { title: "Shell fixture" } })).data
  const command = "printf 'shell fixture\\n'"
  // Invoke only the local SDK inside an isolated disposable runtime. This does
  // not add shell execution to the remote command dispatcher.
  const native = await client.session.shell({ path: { id: session.id }, body: { agent: "build", command,
    model: { providerID: "fixture", modelID: "fixture" } } })
  assert.equal(native.error, undefined)
  assert.ok(native.data.parts.some((p) => p.type === "tool" && p.tool === "bash" && p.state.output === "shell fixture\n"))
  await eventually(() => assert.equal(f.connections.length, 1))
  const connection = f.connections[0]
  const projects = await f.remoteRequest(connection, "project.list", { version: 1 })
  const request = { version: 1, projectId: projects.body.projects[0].id, sessionId: session.id, includeTools: true }
  for (const includeShell of [undefined, false, true]) {
    const response = await f.remoteRequest(connection, "chat.snapshot", { ...request,
      ...(includeShell !== undefined ? { includeShell } : {}) })
    chatResponses["chat.snapshot"].parse(response.body)
    const message = response.body.messages.find((m) => m.role === "assistant")
    const tool = message.parts.find((p) => p.tool?.operation === "execute").tool
    if (includeShell) assert.deepEqual(tool.shell, { command, output: "shell fixture\n", truncated: false })
    else {
      assert.equal(tool.shell, undefined)
      assert.equal(JSON.stringify(response.body).includes(command), false)
      assert.equal(JSON.stringify(response.body).includes("shell fixture\\n"), false)
    }
    assert.equal(response.body.messages.find((m) => m.role === "user").text, "")
  }
  const marker = await f.remoteRequest(connection, "chat.shell", { version: 1 })
  assert.equal(marker.body.code, "unsupported_operation")
  const foreign = (await f.client(f.dirs["repo-b"]).session.create({ body: { title: "Foreign" } })).data
  const denied = await f.remoteRequest(connection, "chat.snapshot", { ...request, sessionId: foreign.id, includeShell: true })
  assert.equal(denied.body.code, "access_denied")
})
