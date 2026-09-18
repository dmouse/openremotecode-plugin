import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { chatMessageContent } from "../../dist/chat-message.js"

const fixture = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-reasoning-v1.json", import.meta.url), "utf8"))
const tools = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-tools-v1.json", import.meta.url), "utf8"))
const shells = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-shell-v1.json", import.meta.url), "utf8"))

test("native shell pair matches shared fixture and details require both opt-ins", () => {
  const { id: _id, role, ...expected } = shells.response.messages[1]
  assert.deepEqual(chatMessageContent(role, shells.nativeParts, undefined,
    { includeTools: true, includeShell: true }), expected)
  assert.deepEqual(chatMessageContent("user", shells.userNativeParts), { text: "", truncated: false })
  for (const options of [{}, { includeTools: true }, { includeShell: true },
    { includeTools: true, includeShell: false }]) {
    const result = chatMessageContent(role, shells.nativeParts, undefined, options)
    assert.equal(result.text, expected.text)
    assert.equal(JSON.stringify(result).includes("shell fixture"), false)
  }
  assert.equal(JSON.stringify(expected).includes("PRIVATE_"), false)
})

test("shell snapshots normalize pending, streaming, completed, empty and failed output", () => {
  const render = (state) => chatMessageContent("assistant", [{ ...shells.nativeParts[0], state }],
    undefined, { includeTools: true, includeShell: true }).parts[0].tool.shell
  const input = { command: "fixture" }
  assert.equal(render({ status: "pending", input }).output, "")
  assert.equal(render({ status: "running", input, metadata: { output: "partial" } }).output, "partial")
  assert.equal(render({ status: "completed", input, output: "final", metadata: { output: "stale" } }).output, "final")
  assert.equal(render({ status: "completed", input, output: "" }).output, "")
  assert.equal(render({ status: "error", input, error: "failed" }).output, "failed")
  assert.equal(render({ status: "error", input, error: "failed", metadata: { output: "partial" } }).output, "partial")
  assert.equal(render({ status: "running", input, metadata: { output: {}, arbitrary: "PRIVATE_" } }).output, "")
  assert.equal(render({ status: "completed", input, output: "short", metadata: { truncated: true } }).truncated, true)
  assert.equal(render({ status: "completed", input,
    output: "\x1b[31mred\x1b[0m\r\n\x1b]8;;https://example.test\x07link\x1b]8;;\x07\u202e\x00" }).output, "red\nlink")
})

test("shell details consume shared bounds and never expand other tool payloads", () => {
  const part = structuredClone(shells.nativeParts[0])
  part.state.input.command = "c".repeat(9000)
  part.state.output = "o".repeat(40000)
  const result = chatMessageContent("assistant", [part, { id: "text", type: "text", text: "t".repeat(9000) }],
    undefined, { includeTools: true, includeShell: true })
  const shell = result.parts[0].tool.shell
  assert.equal(shell.command.length, 8000)
  assert.equal(shell.output.length, 32000)
  assert.equal(shell.truncated, true)
  assert.equal(result.truncated, true)
  assert.equal(result.parts.reduce((n, p) => n + p.text.length, 0) + shell.command.length + shell.output.length, 48000)
  part.tool = "read"
  const other = chatMessageContent("assistant", [part], undefined, { includeTools: true, includeShell: true })
  assert.equal(other.parts[0].tool.shell, undefined)
  assert.equal(JSON.stringify(other).includes("oooo"), false)
})

test("structured tools match the shared fixture only when requested", () => {
  const { id: _id, role, ...expected } = tools.response.messages[0]
  assert.deepEqual(chatMessageContent(role, tools.nativeParts, undefined,
    { includeTools: true, directory: "/workspace" }), expected)
  assert.deepEqual(chatMessageContent(role, tools.nativeParts), { text: expected.text, truncated: false })
  assert.equal(JSON.stringify(expected).includes("PRIVATE_"), false)
})

test("file mentions retain authored text and label, never synthetic context or payloads", () => {
  const { id: _id, role, ...expected } = tools.userResponse
  const parts = structuredClone(tools.userNativeParts)
  parts[2].text = "PRIVATE_ATTACHMENT_CONTENT".repeat(5000)
  assert.deepEqual(chatMessageContent(role, parts), expected)
  // File-looking authored prose must not be heuristically removed.
  assert.equal(chatMessageContent("user", [{ id: "p", type: "text",
    text: "Called the Read tool: literal authored text" }]).text,
    "Called the Read tool: literal authored text\n")
  assert.equal(chatMessageContent("assistant", tools.userNativeParts).text,
    "Review @example.dart\n")
})

test("tool display allowlist excludes raw input, output, errors and invalid clocks", () => {
  for (const name of ["unknown_mcp", "__proto__", "constructor", "webfetch", "grep", "glob"]) {
    const result = chatMessageContent("assistant", [{ id: "p", type: "tool", tool: name,
      state: { status: "running", input: { command: "PRIVATE_", url: "PRIVATE_", pattern: "approved pattern" },
        title: "PRIVATE_", output: "PRIVATE_", error: "PRIVATE_", time: { start: 0, end: 10 } } }],
    undefined, { includeTools: true })
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false)
    assert.equal(result.parts[0].tool.durationMs, undefined)
  }
  for (const time of [undefined, { start: -1, end: 10 }, { start: 10, end: 9 },
    { start: 0.5, end: 1 }, { start: 0, end: Infinity }]) {
    const part = structuredClone(tools.nativeParts[0])
    part.state.time = time
    part.state.input.filePath = "/outside/private/example.dart"
    const tool = chatMessageContent("assistant", [part], undefined,
      { includeTools: true, directory: "/workspace" }).parts[0].tool
    assert.equal(tool.durationMs, undefined)
    assert.equal(tool.description, "example.dart")
  }
})

test("search summaries include only bounded patterns and display locations", () => {
  const summary = (name, input) => chatMessageContent("assistant", [{ id: "p", type: "tool", tool: name,
    state: { status: "completed", input, output: "PRIVATE_RESULTS", time: { start: 0, end: 1 } } }],
    undefined, { includeTools: true, directory: "/workspace" }).parts[0].tool
  assert.equal(summary("glob", { pattern: "**/*.dart", path: "/workspace/mobile" }).description,
    '"**/*.dart" in mobile')
  assert.equal(summary("grep", { pattern: "Theme|Color", path: "/workspace" }).description,
    '"Theme|Color" in .')
  assert.equal(summary("grep", { pattern: "needle" }).description, '"needle"')
  assert.equal(summary("glob", { path: "/outside/private/lib" }).description, 'in lib')
  assert.equal(summary("grep", { pattern: {}, path: [] }).description, undefined)
  assert.equal(summary("glob", { pattern: "a\n\u202eb", path: "mobile\nlib" }).description,
    '"a  b" in mobile lib')
  const long = summary("grep", { pattern: "p".repeat(1000), path: "d".repeat(1000), extra: "PRIVATE_" })
  assert.ok(long.description.length <= 256)
  assert.equal(JSON.stringify(long).includes("PRIVATE_"), false)
})

test("MCP and internal actions have useful descriptions without exposing arguments", () => {
  for (const [name, description] of [
    ["mobile-mcp_mobile_take_screenshot", "Capture screen"],
    ["mobile-mcp_mobile_list_elements_on_screen", "Inspect screen elements"],
    ["mobile-mcp_mobile_launch_app", "Open app"],
    ["mobile-mcp_mobile_click_on_screen_at_coordinates", "Tap screen"],
    ["context7_query-docs", "Look up documentation"],
    ["apply_patch", "Apply patch"],
    ["todowrite", "Update task list"],
    ["custom_inspection", "Custom inspection"],
    ["__proto__", "Proto"],
  ]) {
    const result = chatMessageContent("assistant", [{ id: "p", type: "tool", tool: name,
      state: { status: "completed", input: { text: "PRIVATE_TEXT", path: "PRIVATE_PATH" },
        output: "PRIVATE_OUTPUT", title: "PRIVATE_TITLE", metadata: { description: "PRIVATE_METADATA" } } }],
      undefined, { includeTools: true })
    assert.equal(result.parts[0].tool.description, description)
    assert.equal(JSON.stringify(result).includes("PRIVATE_"), false)
  }
})

test("a completed question tool call shows what was asked, and what was answered when the plugin resolved it", () => {
  const questionPart = (questions) => ({ id: "p", type: "tool", tool: "question",
    state: { status: "completed", input: { questions }, output: "PRIVATE_NATIVE_OUTPUT",
      metadata: { answers: ["PRIVATE_NATIVE_METADATA"] }, time: { start: 0, end: 1 } } })
  const single = [{ header: "Environment", question: "Where are you testing?",
    options: [{ label: "Local" }, { label: "CI" }] }]

  // No cache at all: still shows what was asked, from the tool's own trusted input.
  const asked = chatMessageContent("assistant", [questionPart(single)], undefined,
    { includeTools: true }).parts[0].tool
  assert.equal(asked.operation, "question")
  assert.equal(asked.description, "Environment")
  assert.equal(JSON.stringify(asked).includes("PRIVATE_NATIVE"), false)

  // A matching cached record (by sanitized content, not a native id) adds the answer.
  const answered = chatMessageContent("assistant", [questionPart(single)], undefined,
    { includeTools: true, answeredQuestions: [{
      questions: [{ header: "Environment", question: "Where are you testing?",
        options: [{ label: "Local" }, { label: "CI" }], multiple: false, custom: true }],
      answers: ["Local"],
    }] }).parts[0].tool
  assert.equal(answered.description, "Environment: Local")

  // A multi-question batch shows every entry, in order.
  const batch = [
    { header: "Environment", question: "Where?", options: [{ label: "Local" }] },
    { header: "Platform", question: "Which platform?", multiple: true, custom: false,
      options: [{ label: "Android" }, { label: "iOS" }] },
  ]
  const batchAnswered = chatMessageContent("assistant", [questionPart(batch)], undefined,
    { includeTools: true, answeredQuestions: [{
      questions: [
        { header: "Environment", question: "Where?", options: [{ label: "Local" }], multiple: false, custom: true },
        { header: "Platform", question: "Which platform?",
          options: [{ label: "Android" }, { label: "iOS" }], multiple: true, custom: false },
      ],
      answers: ["Local", "Android, iOS"],
    }] }).parts[0].tool
  assert.equal(batchAnswered.description, "Environment: Local · Platform: Android, iOS")

  // A cache entry for different question content never matches (e.g. a different batch,
  // or a stale entry from before a restart) -- falls back to headers-only, never a wrong pairing.
  const mismatched = chatMessageContent("assistant", [questionPart(single)], undefined,
    { includeTools: true, answeredQuestions: [{
      questions: [{ header: "Unrelated", question: "Something else?",
        options: [{ label: "A" }], multiple: false, custom: true }],
      answers: ["A"],
    }] }).parts[0].tool
  assert.equal(mismatched.description, "Environment")

  // A rejected batch is recorded as declined for every question.
  const declined = chatMessageContent("assistant", [questionPart(single)], undefined,
    { includeTools: true, answeredQuestions: [{
      questions: [{ header: "Environment", question: "Where are you testing?",
        options: [{ label: "Local" }, { label: "CI" }], multiple: false, custom: true }],
      answers: ["Declined"],
    }] }).parts[0].tool
  assert.equal(declined.description, "Environment: Declined")

  // A free-text answer is re-sanitized here even though the label/question already were --
  // it was forwarded as the user typed it and never itself passed through stripping.
  const custom = chatMessageContent("assistant", [questionPart(single)], undefined,
    { includeTools: true, answeredQuestions: [{
      questions: [{ header: "Environment", question: "Where are you testing?",
        options: [{ label: "Local" }, { label: "CI" }], multiple: false, custom: true }],
      answers: ["Staging\x00‮"],
    }] }).parts[0].tool
  assert.equal(custom.description, "Environment: Staging")

  // The joined description is still bounded to 256 like every other tool description.
  const long = [{ header: "H".repeat(64), question: "Q?", options: [{ label: "x" }] },
    { header: "H2".repeat(64), question: "Q2?", options: [{ label: "y" }] }]
  const longResult = chatMessageContent("assistant", [questionPart(long)], undefined,
    { includeTools: true, answeredQuestions: [{
      questions: [
        { header: "H".repeat(64), question: "Q?", options: [{ label: "x" }], multiple: false, custom: true },
        { header: "H2".repeat(64), question: "Q2?", options: [{ label: "y" }], multiple: false, custom: true },
      ],
      answers: ["A".repeat(200), "B".repeat(200)],
    }] }).parts[0].tool
  assert.ok(longResult.description.length <= 256)
})

test("reasoning fixture preserves order and timing while dropping native metadata", () => {
  const { id: _id, role, ...expected } = fixture.response.messages[0]
  assert.deepEqual(chatMessageContent(role, fixture.nativeParts), expected)
  assert.deepEqual(chatMessageContent("user", fixture.nativeParts), {
    text: expected.text + '[File: File]\n', truncated: false,
  })
})

test("missing and malformed native clocks never produce invented durations", () => {
  for (const time of [undefined, { start: -1 }, { start: NaN }, { start: 1, end: 0 },
    { start: 0, end: Infinity }, { start: 0.5, end: 2 }]) {
    const result = chatMessageContent("assistant", [{ id: "p", type: "reasoning", text: "", time }])
    assert.deepEqual(result.parts, [{ id: "p", type: "reasoning", text: "" }])
  }
  const time = { start: 1000 }
  assert.deepEqual(chatMessageContent("assistant", [{ id: "p", type: "reasoning", text: "Live", time }]).parts[0].time, time)
})

test("reasoning and answers share bounded text and part budgets", () => {
  const result = chatMessageContent("assistant", [
    { id: "r", type: "reasoning", text: "r".repeat(47990) },
    { id: "t", type: "text", text: "answer".repeat(100) },
  ])
  assert.equal(result.truncated, true)
  assert.equal(result.text.length, 10)
  assert.equal(result.parts.reduce((n, p) => n + p.text.length, 0), 48000)
  const many = chatMessageContent("assistant", Array.from({ length: 101 }, (_, i) => ({ id: `r${i}`, type: "reasoning", text: "" })))
  assert.equal(many.parts.length, 100)
  assert.equal(many.truncated, true)
  assert.equal(chatMessageContent("assistant", [{ id: "r", type: "reasoning", text: "r".repeat(48000) }]).truncated, false)
})
