import assert from "node:assert/strict"
import test from "node:test"
import { convertNextMessage, readMessageHistory } from "../../dist/message-history.js"
import { chatMessageContent } from "../../dist/chat-message.js"

test("mixed-engine pagination anchors partial pages while new messages arrive", async () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, type: 'user', text: `Body ${index}`, time: { created: index + 1 } }))
  const stores = { legacy: entries.filter((_, i) => i % 2 === 0), next: entries.filter((_, i) => i % 2 === 1) }
  const legacy = (m) => ({ info: { id: m.id, sessionID: 'session', role: 'user', time: m.time },
    parts: [{ id: `p-${m.id}`, type: 'text', sessionID: 'session', messageID: m.id, text: m.text }] })
  const client = { session: {
    messages: async ({ url, query }) => {
      const source = url ? 'next' : 'legacy'
      const before = Number(query.cursor ?? query.before ?? Infinity)
      if (query.cursor) assert.equal(query.order, undefined)
      const remaining = stores[source].filter((m) => m.time.created < before).sort((a, b) => b.time.created - a.time.created)
      const page = remaining.slice(0, 10)
      const cursor = remaining.length > 10 ? String(page.at(-1).time.created) : undefined
      return url ? { data: { data: page, cursor: cursor ? { next: cursor } : {} }, response: new Response(null) }
        : { data: page.map(legacy).reverse(), response: new Response(null, { headers: cursor ? { 'x-next-cursor': cursor } : {} }) }
    },
    message: async ({ url, path }) => {
      const source = url ? 'next' : 'legacy'
      const message = stores[source].find((m) => m.id === path.messageID)
      assert.equal(path.id, 'session')
      return { data: url ? { data: message } : legacy(message), response: new Response(null) }
    },
  } }
  let result = await readMessageHistory(client, '/workspace', 'session', undefined, new AbortController().signal)
  const ids = result.messages.map((m) => m.info.id)
  assert.deepEqual(ids, entries.slice(20).map((m) => m.id))
  assert.equal(result.cursor.includes('Body'), false)
  stores.next.push({ id: 'new', type: 'user', text: 'New message', time: { created: 1000 } })
  while (result.cursor) {
    result = await readMessageHistory(client, '/workspace', 'session', result.cursor, new AbortController().signal)
    ids.unshift(...result.messages.map((m) => m.info.id))
  }
  assert.deepEqual(ids, entries.map((m) => m.id))
  assert.equal(new Set(ids).size, 30)
})

test("next history uses the presentation allowlist, not provider metadata or non-shell tool output", async () => {
  const message = { id: 'assistant', type: 'assistant', time: { created: 1, completed: 4 },
    metadata: { secret: 'PRIVATE' }, content: [
      { id: 'r', type: 'reasoning', text: 'Review', providerMetadata: { secret: 'PRIVATE' }, time: { created: 1, completed: 2 } },
      { id: 'read', type: 'tool', name: 'read', time: { created: 2, completed: 3 },
        state: { status: 'completed', input: { filePath: 'a.dart' }, content: [{ type: 'text', text: 'PRIVATE' }], structured: { secret: 'PRIVATE' } } },
      { id: 't', type: 'text', text: 'Answer' },
    ] }
  const client = { session: { messages: async ({ url }) => ({ data: url ? { data: [message], cursor: {} } : [], response: new Response(null) }) } }
  const result = await readMessageHistory(client, '/workspace', 'session', undefined, new AbortController().signal)
  const projected = chatMessageContent('assistant', result.messages[0].parts, undefined, { includeTools: true, includeActivities: true })
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false)
  assert.equal(projected.parts[0].activity.state, 'completed')
  assert.equal(projected.parts[1].tool.description, 'a.dart')
})

test("next engine's ModelRef is normalized to the same flat modelID/providerID/variant fields the legacy engine already carries", async () => {
  const message = { id: 'assistant', type: 'assistant', time: { created: 1, completed: 4 },
    model: { id: 'gpt-5.6-sol', providerID: 'openai', variant: 'high' }, content: [{ id: 't', type: 'text', text: 'Answer' }] }
  const client = { session: { messages: async ({ url }) => ({ data: url ? { data: [message], cursor: {} } : [], response: new Response(null) }) } }
  const result = await readMessageHistory(client, '/workspace', 'session', undefined, new AbortController().signal)
  assert.deepEqual({ modelID: result.messages[0].info.modelID, providerID: result.messages[0].info.providerID,
    variant: result.messages[0].info.variant }, { modelID: 'gpt-5.6-sol', providerID: 'openai', variant: 'high' })
})

test("a next engine model without a variant carries no variant field, and a malformed model carries neither", async () => {
  const noVariant = { id: 'a1', type: 'assistant', time: { created: 1 }, model: { id: 'claude', providerID: 'anthropic' }, content: [] }
  const malformed = { id: 'a2', type: 'assistant', time: { created: 2 }, model: 'claude/anthropic', content: [] }
  const client = { session: { messages: async ({ url }) =>
    ({ data: url ? { data: [noVariant, malformed], cursor: {} } : [], response: new Response(null) }) } }
  const result = await readMessageHistory(client, '/workspace', 'session', undefined, new AbortController().signal)
  assert.deepEqual({ modelID: result.messages[0].info.modelID, providerID: result.messages[0].info.providerID,
    variant: result.messages[0].info.variant }, { modelID: 'claude', providerID: 'anthropic', variant: undefined })
  assert.deepEqual({ modelID: result.messages[1].info.modelID, providerID: result.messages[1].info.providerID },
    { modelID: undefined, providerID: undefined })
})

test("a v2 streaming tool status is treated as running, not thrown on", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1 },
      state: { status: "streaming", input: "{\"command\": \"ls" } },
  ] }
  const { parts } = convertNextMessage(message, "session")
  assert.equal(parts[0].state.status, "running")
  assert.deepEqual(parts[0].state.input, {}, "a partial JSON-string input is not forwarded as an object")
})

test("a v2 running tool's own metadata.output and truncated flag survive instead of a synthesized empty one", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1, ran: 2 },
      state: { status: "running", input: { command: "ls -la" }, metadata: { output: "partial output so far", truncated: true } } },
  ] }
  const { parts } = convertNextMessage(message, "session")
  const projected = chatMessageContent("assistant", parts, undefined, { includeTools: true, includeShell: true })
  assert.equal(projected.parts[0].tool.shell.output, "partial output so far")
  assert.equal(projected.parts[0].tool.shell.truncated, true)
})

test("a v2 error tool state falls back to its own metadata.output, then to the error message", () => {
  const withOutput = { id: "assistant", type: "assistant", time: { created: 1, completed: 2 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1, completed: 2 },
      state: { status: "error", input: { command: "false" }, error: { type: "exit", message: "exit 1" }, metadata: { output: "before it failed" } } },
  ] }
  const first = chatMessageContent("assistant", convertNextMessage(withOutput, "session").parts, undefined, { includeTools: true, includeShell: true })
  assert.equal(first.parts[0].tool.shell.output, "before it failed")
  const withoutOutput = { id: "assistant", type: "assistant", time: { created: 1, completed: 2 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1, completed: 2 },
      state: { status: "error", input: { command: "false" }, error: { type: "exit", message: "exit 1" } } },
  ] }
  const second = chatMessageContent("assistant", convertNextMessage(withoutOutput, "session").parts, undefined, { includeTools: true, includeShell: true })
  assert.equal(second.parts[0].tool.shell.output, "exit 1")
})

test("a v2 completed tool's transcript content becomes both the summary text and shell output", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1, completed: 3 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1, ran: 1, completed: 3 },
      state: { status: "completed", input: { command: "echo hi" }, content: [{ type: "text", text: "hi" }] } },
  ] }
  const { parts } = convertNextMessage(message, "session")
  assert.equal(parts[0].state.output, "hi")
  assert.equal(parts[0].state.metadata.output, "hi")
  const projected = chatMessageContent("assistant", parts, undefined, { includeTools: true, includeShell: true })
  assert.equal(projected.parts[0].tool.shell.command, "echo hi")
  assert.equal(projected.parts[0].tool.shell.output, "hi")
  assert.equal(projected.parts[0].tool.operation, "execute")
})

test("a non-shell v2 tool (e.g. a subagent task, with includeSubtasks unsupported) still gets a bounded generic summary", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1, completed: 2 }, content: [
    { id: "task1", type: "tool", name: "task", time: { created: 1, completed: 2 },
      state: { status: "completed", input: { description: "Investigate the failing test" }, content: [{ type: "text", text: "Done" }] } },
  ] }
  const { parts } = convertNextMessage(message, "session")
  const projected = chatMessageContent("assistant", parts, undefined, { includeTools: true })
  assert.equal(projected.parts[0].tool.operation, "tool")
  assert.equal(projected.parts[0].tool.description, "Run subtask")
  assert.equal(JSON.stringify(projected).includes("Investigate"), false, "raw tool input is never forwarded for the generic bucket")
})

test("a v2 user file attachment reconstructs the v1 data: URI from inline base64 + mime", () => {
  const message = { id: "assistant", type: "user", time: { created: 1 }, text: "see attached",
    files: [{ name: "diagram.png", mime: "image/png", data: "AAAA", source: { type: "inline" } }] }
  const { parts } = convertNextMessage(message, "session")
  assert.equal(parts[1].type, "file")
  assert.equal(parts[1].mime, "image/png")
  assert.equal(parts[1].url, "data:image/png;base64,AAAA")
})

test("a v2 uri-sourced file attachment (no inline bytes) degrades to a label, not a broken url", () => {
  const message = { id: "assistant", type: "user", time: { created: 1 }, text: "see attached",
    files: [{ name: "report.pdf", mime: "application/pdf", source: { type: "uri", uri: "file:///tmp/report.pdf" } }] }
  const { parts } = convertNextMessage(message, "session")
  assert.equal(parts[1].url, "")
  assert.equal(parts[1].mime, "application/pdf")
})
