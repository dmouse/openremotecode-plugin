import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"
import { LiveParts } from "../../dist/live-parts.js"

const nativeQuestion = {
  id: "qst_pending", sessionID: "ses_questions",
  questions: [{ question: "Which todo item should we focus on next?", header: "Next step",
    multiple: false, options: [{ label: "Item Alpha", description: "High-priority item" },
      { label: "Item Beta", description: "Medium-priority item" }] }],
}
const summarized = { id: "qst_pending", questions: [{ header: "Next step",
  question: "Which todo item should we focus on next?",
  options: [{ label: "Item Alpha", description: "High-priority item" },
    { label: "Item Beta", description: "Medium-priority item" }], multiple: false, custom: true }] }

const nativeBatch = {
  id: "qst_batch", sessionID: "ses_questions",
  questions: [
    { question: "Which todo item should we focus on next?", header: "Next step", multiple: false,
      options: [{ label: "Item Alpha" }, { label: "Item Beta" }] },
    { question: "Which platforms should the release cover?", header: "Targets", multiple: true,
      custom: false, options: [{ label: "iOS" }, { label: "Android" }] },
  ],
}

async function questionAdapter(t, { list = [nativeQuestion], fail = false, messages = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "chat-question-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = { id: "ses_questions", title: "Question presentation", directory: root, time: { updated: 1000 } }
  const reads = []
  const client = {
    session: {
      get: async () => ({ data: session, response: { ok: true } }),
      status: async () => ({ data: {}, response: { ok: true } }),
      messages: async ({ url }) => url
        ? { data: { data: [], cursor: {} }, response: { ok: true } }
        : { data: messages, response: new Response(null) },
      list: async (options) => {
        // Generated SDK methods bind their verb as `request({ ...options, method })`, so a
        // `method` supplied by the caller is overwritten and never honored. Modelling that
        // here is the point: the fake previously recorded the caller's intended method, so
        // a reply routed through this GET-based method looked like a POST in the test while
        // the real client sent `GET /question/{id}/reply` and OpenCode refused every answer.
        reads.push({ ...options, method: "GET" })
        if (fail) throw new Error("native failure")
        return { data: list, response: { ok: true } }
      },
    },
    postSessionIdPermissionsPermissionId: async (options) => {
      reads.push({ ...options, method: "POST" })
      if (fail) throw new Error("native failure")
      return { data: {}, response: { ok: true } }
    },
  }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  return { adapter, reads, root, body: { version: 1, projectId: projects[0].id, sessionId: session.id } }
}

test("chat.snapshot falls back to the GET /question list when nothing was captured live", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t)
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeQuestions: true })
  assert.deepEqual(snapshot.question, summarized)
  assert.equal(reads.at(-1).url, "/question")
  assert.ok(reads.at(-1).signal instanceof AbortSignal)
})

test("chat.snapshot ignores a pending question that belongs to a different session", async (t) => {
  const { adapter, body } = await questionAdapter(t, {
    list: [{ ...nativeQuestion, id: "qst_other", sessionID: "ses_someone_else" }],
  })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeQuestions: true })
  assert.equal(snapshot.question, null)
})

test("chat.snapshot reports no question rather than leaking a native list failure", async (t) => {
  const { adapter, body } = await questionAdapter(t, { fail: true })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeQuestions: true })
  assert.equal(snapshot.question, null)
})

test("chat.snapshot never reads the native list when nothing opted in, or when a live value already exists", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t)
  for (const optOut of [{}, { includeQuestions: false }]) {
    const snapshot = await adapter.execute("chat.snapshot", { ...body, ...optOut })
    assert.equal(Object.hasOwn(snapshot, "question"), false)
  }
  assert.equal(reads.length, 0, "opting out never triggers the native read")
})

test("chat.snapshot prefers an event-captured question over the on-demand fallback read", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t, {
    list: [{ ...nativeQuestion, id: "qst_stale" }],
  })
  const live = new LiveParts(body.sessionId)
  live.capture({ type: "question.asked", properties: nativeQuestion })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeQuestions: true }, undefined, live)
  assert.deepEqual(snapshot.question, summarized)
  assert.equal(reads.length, 0, "the live value is preferred without a native read")
})

test("chat.snapshot forwards a whole multi-question batch, in order, under one id", async (t) => {
  const { adapter, body } = await questionAdapter(t, { list: [nativeBatch] })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeQuestions: true })
  assert.equal(snapshot.question.id, "qst_batch")
  assert.equal(snapshot.question.questions.length, 2)
  assert.equal(snapshot.question.questions[0].header, "Next step")
  assert.equal(snapshot.question.questions[1].header, "Targets")
  assert.equal(snapshot.question.questions[1].custom, false)
})

test("a reply reaches OpenCode through the ordinary request path, with no live parts", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t)

  // The dispatcher calls execute(operation, body) with no live argument, so a reply that
  // depends on one can never succeed. This is the shape the real relay request takes.
  const result = await adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_pending", response: "answer", answers: [{ selected: [1] }],
  })
  assert.deepEqual(result, { version: 1, accepted: true })

  const reply = reads.find((options) => String(options?.url ?? "").endsWith("/reply"))
  assert.ok(reply, "no reply was sent to OpenCode")
  assert.equal(reply.url, "/question/qst_pending/reply")
  assert.equal(reply.method, "POST")
  // The label is resolved from the question the plugin observed, never sent by the client.
  assert.deepEqual(reply.body, { answers: [["Item Beta"]] })
})

test("a reply resolves against live parts when a subscription holds the question", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t, { list: [] })
  const live = new LiveParts(body.sessionId)
  live.capture({ type: "question.asked", properties: nativeQuestion })

  const result = await adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_pending", response: "answer", answers: [{ selected: [0] }],
  }, undefined, live)
  assert.deepEqual(result, { version: 1, accepted: true })
  const reply = reads.find((options) => String(options?.url ?? "").endsWith("/reply"))
  assert.deepEqual(reply.body, { answers: [["Item Alpha"]] })
})

test("a reply answers a multi-question batch in order, in one request", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t, { list: [nativeBatch] })
  const result = await adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_batch", response: "answer",
    answers: [{ selected: [1] }, { selected: [0, 1] }],
  })
  assert.deepEqual(result, { version: 1, accepted: true })
  const reply = reads.find((options) => String(options?.url ?? "").endsWith("/reply"))
  assert.equal(reply.url, "/question/qst_batch/reply")
  assert.deepEqual(reply.body, { answers: [["Item Beta"], ["iOS", "Android"]] })
})

test("a reply with the wrong number of answers for a batch fails closed", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t, { list: [nativeBatch] })
  await assert.rejects(adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_batch", response: "answer", answers: [{ selected: [0] }],
  }), (error) => error.code === "context_expired")
  assert.equal(reads.some((options) => String(options?.url ?? "").includes("/reply")), false,
    "a short answer list still sent a reply")
})

test("rejecting a batch declines all of it, from a single call", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t, { list: [nativeBatch] })
  const result = await adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_batch", response: "reject",
  })
  assert.deepEqual(result, { version: 1, accepted: true })
  const reply = reads.find((options) => String(options?.url ?? "").endsWith("/reject"))
  assert.equal(reply.url, "/question/qst_batch/reject")
})

test("a reply to a question this connector never saw fails closed", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t, { list: [] })

  await assert.rejects(adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_unknown", response: "answer", answers: [{ selected: [0] }],
  }), (error) => error.code === "context_expired")
  assert.equal(reads.some((options) => String(options?.url ?? "").includes("/reply")), false,
    "an unresolved question still sent an answer")

  // An index the schema accepts but the captured option list does not cover is equally
  // unresolvable; anything beyond the schema's own bound never reaches this logic.
  await assert.rejects(adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_pending", response: "answer", answers: [{ selected: [5] }],
  }), (error) => error.code === "context_expired")
})

test("free-text answers forward exactly what the user typed, mirroring OpenCode's own TUI", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t)
  const result = await adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_pending", response: "answer",
    answers: [{ text: "Neither -- fix Item Gamma first." }],
  })
  assert.deepEqual(result, { version: 1, accepted: true })
  const reply = reads.find((options) => String(options?.url ?? "").endsWith("/reply"))
  assert.deepEqual(reply.body, { answers: [["Neither -- fix Item Gamma first."]] })
})

test("a question that opts out of custom answers rejects free text even though it resolves", async (t) => {
  const optedOut = { ...nativeQuestion,
    questions: [{ ...nativeQuestion.questions[0], custom: false }] }
  const { adapter, reads, body } = await questionAdapter(t, { list: [optedOut] })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeQuestions: true })
  assert.equal(snapshot.question.questions[0].custom, false)
  await assert.rejects(adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_pending", response: "answer", answers: [{ text: "I'll type my own anyway" }],
  }), (error) => error.code === "context_expired")
  assert.equal(reads.some((options) => String(options?.url ?? "").includes("/reply")), false)
  // The fixed options still work for the same question.
  const result = await adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_pending", response: "answer", answers: [{ selected: [0] }],
  })
  assert.deepEqual(result, { version: 1, accepted: true })
})

test("in a batch, only the entry that opts in accepts free text", async (t) => {
  const { adapter, reads, body } = await questionAdapter(t, { list: [nativeBatch] })
  // Index 1 ("Targets") has custom: false.
  await assert.rejects(adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_batch", response: "answer",
    answers: [{ selected: [0] }, { text: "Both, but iOS first" }],
  }), (error) => error.code === "context_expired")
  assert.equal(reads.some((options) => String(options?.url ?? "").includes("/reply")), false)
})

function questionToolMessage(questions) {
  return { info: { id: "msg_question", sessionID: "ses_questions", role: "assistant",
    time: { created: 1000, completed: 1000 } },
  parts: [{ id: "tool_question", type: "tool", tool: "question",
    state: { status: "completed", input: { questions }, output: "PRIVATE_NATIVE_OUTPUT",
      metadata: { answers: ["PRIVATE_NATIVE_METADATA"] }, time: { start: 0, end: 1 } } }] }
}

test("once answered, the completed question tool call's transcript entry shows what was asked and chosen", async (t) => {
  const { adapter, body } = await questionAdapter(t,
    { list: [nativeQuestion], messages: [questionToolMessage(nativeQuestion.questions)] })
  await adapter.execute("chat.question.reply", {
    ...body, questionId: "qst_pending", response: "answer", answers: [{ selected: [1] }],
  })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeTools: true })
  const tool = snapshot.messages[0].parts[0].tool
  assert.equal(tool.operation, "question")
  assert.equal(tool.description, "Next step: Item Beta")
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_NATIVE"), false)
})

test("a rejected batch is recorded as declined in the completed transcript entry", async (t) => {
  const { adapter, body } = await questionAdapter(t,
    { list: [nativeQuestion], messages: [questionToolMessage(nativeQuestion.questions)] })
  await adapter.execute("chat.question.reply", { ...body, questionId: "qst_pending", response: "reject" })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, includeTools: true })
  assert.equal(snapshot.messages[0].parts[0].tool.description, "Next step: Declined")
})

// The question tool call a run was interrupted in: OpenCode never writes a
// terminal state for it, so its stored part stays "running" for good and the
// assistant message it belongs to never completes.
const interruptedQuestion = [{ info: { id: "msg_interrupted", sessionID: "ses_questions", role: "assistant",
  time: { created: 1000 } },
parts: [{ id: "tool_interrupted", type: "tool", tool: "question",
  state: { status: "running", input: { questions: nativeQuestion.questions }, time: { start: 1000 } } }] }]
const presentation = { includeQuestions: true, includeTools: true, includeActivities: true }

test("an interrupted question tool stops reading as live work once the session is idle", async (t) => {
  const { adapter, body } = await questionAdapter(t, { list: [], messages: interruptedQuestion })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, ...presentation })
  assert.equal(snapshot.status, "idle")
  assert.equal(snapshot.question, null)
  assert.deepEqual(snapshot.messages[0].parts[0].activity, { kind: "tool", state: "cancelled" })
})

test("a question still waiting on the user keeps its tool call running", async (t) => {
  const { adapter, body } = await questionAdapter(t, { messages: interruptedQuestion })
  const snapshot = await adapter.execute("chat.snapshot", { ...body, ...presentation })
  assert.deepEqual(snapshot.question, summarized)
  assert.deepEqual(snapshot.messages[0].parts[0].activity, { kind: "tool", state: "running" })
})

test("without the question capability an unfinished tool call is reported as OpenCode stored it", async (t) => {
  const { adapter, body } = await questionAdapter(t, { list: [], messages: interruptedQuestion })
  const snapshot = await adapter.execute("chat.snapshot",
    { ...body, includeTools: true, includeActivities: true })
  assert.deepEqual(snapshot.messages[0].parts[0].activity, { kind: "tool", state: "running" })
})
