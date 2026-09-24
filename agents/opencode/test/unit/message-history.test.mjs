import assert from "node:assert/strict"
import test from "node:test"
import { convertMessage } from "../../dist/message-history.js"
import { chatMessageContent } from "../../dist/chat-message.js"

test("history uses the presentation allowlist, not provider metadata or non-shell tool output", () => {
  const message = { id: 'assistant', type: 'assistant', time: { created: 1, completed: 4 },
    metadata: { secret: 'PRIVATE' }, content: [
      { id: 'r', type: 'reasoning', text: 'Review', providerMetadata: { secret: 'PRIVATE' }, time: { created: 1, completed: 2 } },
      { id: 'read', type: 'tool', name: 'read', time: { created: 2, completed: 3 },
        state: { status: 'completed', input: { filePath: 'a.dart' }, content: [{ type: 'text', text: 'PRIVATE' }], structured: { secret: 'PRIVATE' } } },
      { id: 't', type: 'text', text: 'Answer' },
    ] }
  const projected = chatMessageContent('assistant', convertMessage(message, 'session').parts, undefined, { includeTools: true, includeActivities: true })
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false)
  assert.equal(projected.parts[0].activity.state, 'completed')
  assert.equal(projected.parts[1].tool.description, 'a.dart')
})

test("a ModelRef is normalized to flat modelID/providerID/variant fields", () => {
  const message = { id: 'assistant', type: 'assistant', time: { created: 1, completed: 4 },
    model: { id: 'gpt-5.6-sol', providerID: 'openai', variant: 'high' }, content: [{ id: 't', type: 'text', text: 'Answer' }] }
  const { info } = convertMessage(message, 'session')
  assert.deepEqual({ modelID: info.modelID, providerID: info.providerID, variant: info.variant },
    { modelID: 'gpt-5.6-sol', providerID: 'openai', variant: 'high' })
})

test("a model without a variant carries no variant field, and a malformed model carries neither", () => {
  const noVariant = { id: 'a1', type: 'assistant', time: { created: 1 }, model: { id: 'claude', providerID: 'anthropic' }, content: [] }
  const malformed = { id: 'a2', type: 'assistant', time: { created: 2 }, model: 'claude/anthropic', content: [] }
  const first = convertMessage(noVariant, 'session').info
  assert.deepEqual({ modelID: first.modelID, providerID: first.providerID, variant: first.variant },
    { modelID: 'claude', providerID: 'anthropic', variant: undefined })
  const second = convertMessage(malformed, 'session').info
  assert.deepEqual({ modelID: second.modelID, providerID: second.providerID }, { modelID: undefined, providerID: undefined })
})

test("a streaming tool status is treated as running, not thrown on", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1 },
      state: { status: "streaming", input: "{\"command\": \"ls" } },
  ] }
  const { parts } = convertMessage(message, "session")
  assert.equal(parts[0].state.status, "running")
  assert.deepEqual(parts[0].state.input, {}, "a partial JSON-string input is not forwarded as an object")
})

test("a running tool's own metadata.output and truncated flag survive instead of a synthesized empty one", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1, ran: 2 },
      state: { status: "running", input: { command: "ls -la" }, metadata: { output: "partial output so far", truncated: true } } },
  ] }
  const { parts } = convertMessage(message, "session")
  const projected = chatMessageContent("assistant", parts, undefined, { includeTools: true, includeShell: true })
  assert.equal(projected.parts[0].tool.shell.output, "partial output so far")
  assert.equal(projected.parts[0].tool.shell.truncated, true)
})

test("an error tool state falls back to its own metadata.output, then to the error message", () => {
  const withOutput = { id: "assistant", type: "assistant", time: { created: 1, completed: 2 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1, completed: 2 },
      state: { status: "error", input: { command: "false" }, error: { type: "exit", message: "exit 1" }, metadata: { output: "before it failed" } } },
  ] }
  const first = chatMessageContent("assistant", convertMessage(withOutput, "session").parts, undefined, { includeTools: true, includeShell: true })
  assert.equal(first.parts[0].tool.shell.output, "before it failed")
  const withoutOutput = { id: "assistant", type: "assistant", time: { created: 1, completed: 2 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1, completed: 2 },
      state: { status: "error", input: { command: "false" }, error: { type: "exit", message: "exit 1" } } },
  ] }
  const second = chatMessageContent("assistant", convertMessage(withoutOutput, "session").parts, undefined, { includeTools: true, includeShell: true })
  assert.equal(second.parts[0].tool.shell.output, "exit 1")
})

test("a completed tool's transcript content becomes both the summary text and shell output", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1, completed: 3 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1, ran: 1, completed: 3 },
      state: { status: "completed", input: { command: "echo hi" }, content: [{ type: "text", text: "hi" }] } },
  ] }
  const { parts } = convertMessage(message, "session")
  assert.equal(parts[0].state.output, "hi")
  assert.equal(parts[0].state.metadata.output, "hi")
  const projected = chatMessageContent("assistant", parts, undefined, { includeTools: true, includeShell: true })
  assert.equal(projected.parts[0].tool.shell.command, "echo hi")
  assert.equal(projected.parts[0].tool.shell.output, "hi")
  assert.equal(projected.parts[0].tool.operation, "execute")
})

test("a non-shell tool (e.g. a subagent task, with includeSubtasks unsupported) still gets a bounded generic summary", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1, completed: 2 }, content: [
    { id: "task1", type: "tool", name: "task", time: { created: 1, completed: 2 },
      state: { status: "completed", input: { description: "Investigate the failing test" }, content: [{ type: "text", text: "Done" }] } },
  ] }
  const { parts } = convertMessage(message, "session")
  const projected = chatMessageContent("assistant", parts, undefined, { includeTools: true })
  assert.equal(projected.parts[0].tool.operation, "tool")
  assert.equal(projected.parts[0].tool.description, "Run subtask")
  assert.equal(JSON.stringify(projected).includes("Investigate"), false, "raw tool input is never forwarded for the generic bucket")
})

test("a user file attachment reconstructs a data: URI from inline base64 + mime", () => {
  const message = { id: "assistant", type: "user", time: { created: 1 }, text: "see attached",
    files: [{ name: "diagram.png", mime: "image/png", data: "AAAA", source: { type: "inline" } }] }
  const { parts } = convertMessage(message, "session")
  assert.equal(parts[1].type, "file")
  assert.equal(parts[1].mime, "image/png")
  assert.equal(parts[1].url, "data:image/png;base64,AAAA")
})

test("a uri-sourced file attachment (no inline bytes) degrades to a label, not a broken url", () => {
  const message = { id: "assistant", type: "user", time: { created: 1 }, text: "see attached",
    files: [{ name: "report.pdf", mime: "application/pdf", source: { type: "uri", uri: "file:///tmp/report.pdf" } }] }
  const { parts } = convertMessage(message, "session")
  assert.equal(parts[1].url, "")
  assert.equal(parts[1].mime, "application/pdf")
})

test("a content kind this build has never seen costs that part alone, not the whole chat", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1 }, content: [
    { id: "t1", type: "text", text: "before" },
    { id: "x1", type: "diagram", payload: { nodes: 3 } },
    { id: "t2", type: "text", text: "after" },
  ] }
  const { parts } = convertMessage(message, "session")
  assert.deepEqual(parts.map((p) => p.text), ["before", "after"],
    "the unfamiliar part is skipped; the messages around it still read")
})

test("a tool status this build has no slot for skips its call rather than guessing at it", () => {
  const message = { id: "assistant", type: "assistant", time: { created: 1 }, content: [
    { id: "bash1", type: "tool", name: "bash", time: { created: 1 }, state: { status: "aborted", input: { command: "ls" } } },
    { id: "t1", type: "text", text: "and then" },
  ] }
  const { parts } = convertMessage(message, "session")
  assert.equal(parts.length, 1, "presenting it as running or finished when neither is known would be worse")
  assert.equal(parts[0].type, "text")
})

test("a user message without its own text still carries its attachments", () => {
  const message = { id: "user", type: "user", time: { created: 1 },
    files: [{ name: "diagram.png", mime: "image/png", data: "AAAA", source: { type: "inline" } }] }
  const { parts } = convertMessage(message, "session")
  assert.equal(parts.length, 1)
  assert.equal(parts[0].type, "file")
  assert.equal(parts[0].url, "data:image/png;base64,AAAA")
})
