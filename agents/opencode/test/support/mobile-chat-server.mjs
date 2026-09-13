// Isolated native-test companion. Accepts only synthetic test credentials from
// the test app over loopback; never use an interactive account with this helper.
import { createServer } from "node:http"
import { createProjectFixture, eventually } from "./opencode-project-fixture.mjs"
import { seedReasoning } from "./reasoning-fixture.mjs"
import { seedSubtask } from "./subtask-fixture.mjs"

let fixture
let starting = false
let initialized = false
let shellSessionId
let streaming = false
const cleanups = []
const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json")
  if (request.url === "/ready" && request.method === "GET") {
    response.end('{"ready":true}'); return
  }
  if (request.url === "/v1/chat/completions" && request.method === "POST") {
    // A local synthetic provider exercises native reasoning/text lifecycle
    // events. Drain fixture prompts without logging or retaining their content.
    request.resume()
    response.writeHead(200, { "content-type": "text/event-stream" })
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`)
    chunk({ reasoning_content: "Inspecting" })
    const timers = [
      setTimeout(() => chunk({ reasoning_content: " the fixture" }), 600),
      setTimeout(() => chunk({ content: "Live answer" }), 1600),
      setTimeout(() => { chunk({ content: " completed" }, "stop"); response.end("data: [DONE]\n\n") }, 3000),
    ]
    response.on("close", () => { for (const timer of timers) clearTimeout(timer) })
    return
  }
  if (request.url === "/chat/stream" && request.method === "POST") {
    request.resume()
    if (!initialized || streaming) { response.writeHead(409); response.end('{}'); return }
    streaming = true
    try {
      const client = fixture.client(fixture.dirs["repo-a"])
      const executed = await client.session.shell({ path: { id: shellSessionId }, body: {
        agent: "build", model: { providerID: "fixture", modelID: "fixture" },
        command: "printf 'stream first\\n'; sleep 3; printf 'stream last\\n'",
      } })
      if (!executed.data) throw new Error("Fixture unavailable")
      const answer = await fixture.request(undefined, `/api/session/${shellSessionId}/prompt`, {
        method: "POST", body: { prompt: { text: "Synthetic reasoning and reply fixture" } },
      })
      if (answer.status !== 200) throw new Error("Fixture unavailable")
      await eventually(async () => {
        const page = await fixture.request(undefined, `/api/session/${shellSessionId}/message`, { query: { limit: 10, order: "desc" } })
        if (!page.data.data.some((m) => m.type === "assistant" && m.time.completed !== undefined &&
          m.content.some((p) => p.type === "text" && p.text === "Live answer completed"))) throw new Error("Fixture pending")
      })
      response.end('{"ready":true}')
    } catch { response.writeHead(500); response.end('{"code":"stream_fixture_failed"}') }
    finally { streaming = false }
    return
  }
  if (request.method === "POST" && ["/mcp/disconnect", "/mcp/connect"].includes(request.url)) {
    request.resume()
    if (!initialized) {
      response.writeHead(409); response.end('{"code":"fixture_not_ready"}'); return
    }
    try {
      // Fixed inert peer and disposable project only; no request-selected SDK inputs.
      const client = fixture.client(fixture.dirs["repo-a"])
      const result = request.url === "/mcp/disconnect"
        ? await client.mcp.disconnect({ path: { name: "connected-fixture" } })
        : await client.mcp.connect({ path: { name: "connected-fixture" } })
      if (!result.response.ok) throw new Error("MCP fixture unavailable")
      response.end('{"ready":true}')
    } catch {
      response.writeHead(500); response.end('{"code":"mcp_fixture_failed"}')
    }
    return
  }
  if (request.url !== "/initialize" || request.method !== "POST" || starting) {
    response.writeHead(400); response.end('{}'); return
  }
  starting = true
  let stage = "request"
  try {
    let content = ""
    for await (const chunk of request) {
      content += chunk.toString()
      if (content.length > 16000) throw new Error("Input limit")
    }
    const options = JSON.parse(content)
    if (options.authorization?.serviceOrigin !== "http://127.0.0.1:8080") throw new Error("Local tests only")
    stage = "opencode_start"
    fixture = await createProjectFixture({ after: (cleanup) => cleanups.push(cleanup) }, {
      ...options, mcpStatusFixture: true,
      syntheticProviderURL: "http://127.0.0.1:8092/v1",
    })
    const client = fixture.client(fixture.dirs["repo-a"])
    // Health readiness precedes lazy project/plugin initialization. Warm the
    // context with a bounded read; never retry an uncertain session creation.
    stage = "project_warmup"
    await eventually(async () => {
      const status = await client.session.status()
      if (!status.response.ok || !status.data) throw new Error("Project not ready")
    }, 25000)
    stage = "mcp_warmup"
    await eventually(async () => {
      const status = await client.mcp.status()
      if (!status.response.ok || status.data?.["connected-fixture"]?.status !== "connected"
        || status.data?.["disabled-fixture"]?.status !== "disabled"
        || status.data?.["failed-fixture"]?.status !== "failed") throw new Error("MCP not ready")
    }, 25000)
    stage = "parent_session"
    const created = await client.session.create({ body: { title: "Native navigation fixture" } })
    if (!created.data) throw new Error("Fixture unavailable")
    stage = "child_session"
    const child = await client.session.create({ body: {
      parentID: created.data.id, title: "Hidden native sub-agent",
    } })
    if (!child.data?.parentID) throw new Error("Child fixture unavailable")
    stage = "user_messages"
    let parentId
    for (let index = 0; index < 12; index++) {
      const message = await client.session.prompt({ path: { id: created.data.id }, body: {
        noReply: true, model: { providerID: "fixture", modelID: "fixture" },
        parts: [{ type: "text", text: `Native encrypted chat fixture ${index}` },
          ...(index === 11 ? [{ type: "file", filename: "example.txt", mime: "text/plain",
            url: `data:text/plain;base64,${Buffer.from("PRIVATE_ATTACHMENT_CONTENT\n".repeat(2000)).toString("base64")}` }] : [])],
      } })
      if (!message.data) throw new Error("Message fixture unavailable")
      parentId = message.data.info.id
    }
    stage = "reasoning_seed"
    seedReasoning(fixture, created.data.id, parentId)
    stage = "subtask_seed"
    seedSubtask(fixture, created.data.id, child.data.id, parentId)
    stage = "shell_session"
    const shellSession = await fixture.request(undefined, "/api/session", { method: "POST", body: {
      agent: "build", model: { id: "fixture", providerID: "fixture" }, location: { directory: fixture.dirs["repo-a"] },
    } })
    if (shellSession.status !== 200) throw new Error("Shell fixture unavailable")
    shellSessionId = shellSession.data.data.id
    const shell = await client.session.shell({ path: { id: shellSessionId }, body: {
      agent: "build", command: "printf 'shell fixture\\n'",
      model: { providerID: "fixture", modelID: "fixture" },
    } })
    if (!shell.data) throw new Error("Shell fixture unavailable")
    initialized = true
    response.end(JSON.stringify({ ready: true, sessionId: created.data.id, childSessionId: child.data.id,
      shellSessionId }))
  } catch (error) {
    // Fixed setup stages only: never log credentials, requests or raw errors.
    const timeout = error instanceof Error && error.name === "TimeoutError"
    response.writeHead(500); response.end(JSON.stringify({ code: "fixture_failed", stage, timeout }))
  }
})
server.listen(8092, "127.0.0.1")
async function stop() {
  server.closeAllConnections()
  server.close()
  for (const cleanup of cleanups.reverse()) await cleanup()
  process.exit(0)
}
process.once("SIGTERM", () => void stop())
process.once("SIGINT", () => void stop())
