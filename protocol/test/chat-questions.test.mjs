import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  CHAT_CAPABILITIES,
  chatQuestionSchema,
  chatRequests,
  chatResponses,
} from "../dist/index.js"

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/chat-questions-v1.json", import.meta.url), "utf8"),
)

test("the shared fixture describes the contract both languages implement", () => {
  assert.ok(CHAT_CAPABILITIES.includes(fixture.capability))
  assert.ok(CHAT_CAPABILITIES.includes("chat.question.reply"))
  for (const key of ["question", "multipleChoice", "batch"]) {
    assert.deepEqual(chatQuestionSchema.parse(fixture[key]), fixture[key])
  }
  assert.deepEqual(chatRequests["chat.question.reply"].parse(fixture.reply), fixture.reply)
  assert.deepEqual(chatRequests["chat.question.reply"].parse(fixture.batchReply), fixture.batchReply)
  assert.deepEqual(chatRequests["chat.question.reply"].parse(fixture.textReply), fixture.textReply)
  assert.deepEqual(chatRequests["chat.question.reply"].parse(fixture.rejectReply), fixture.rejectReply)
  assert.deepEqual(
    chatResponses["chat.question.reply"].parse({ version: 1, accepted: true }),
    { version: 1, accepted: true },
  )
})

test("only what OpenCode prepared for display crosses the boundary", () => {
  for (const [name, body] of Object.entries(fixture.rejected)) {
    assert.equal(chatQuestionSchema.safeParse(body).success, false, name)
  }
  // The strict schema is what keeps tool input, command text or model output out of a
  // payload the phone will render.
  assert.deepEqual(Object.keys(fixture.question).sort(), ["id", "questions"])
  assert.deepEqual(
    Object.keys(fixture.question.questions[0]).sort(),
    ["custom", "header", "multiple", "options", "question"],
  )
})

test("a batch answers several questions in order under one id", () => {
  const batch = chatQuestionSchema.parse(fixture.batch)
  assert.equal(batch.questions.length, 2)
  assert.equal(batch.questions[0].header, "Migration safety")
  assert.equal(batch.questions[1].header, "Targets")
  // A batch is capped, and cannot be empty.
  assert.equal(chatQuestionSchema.safeParse(fixture.rejected.noQuestions).success, false)
  assert.equal(chatQuestionSchema.safeParse(fixture.rejected.tooManyQuestions).success, false)
})

test("agent-authored text is bounded, so a hostile question cannot flood the client", () => {
  const base = fixture.question
  const prompt = base.questions[0]
  const withPrompt = (override) => ({ ...base, questions: [{ ...prompt, ...override }] })
  assert.equal(chatQuestionSchema.safeParse(withPrompt({ question: "x".repeat(2001) })).success, false)
  assert.equal(chatQuestionSchema.safeParse(withPrompt({ header: "x".repeat(65) })).success, false)
  assert.equal(
    chatQuestionSchema.safeParse(withPrompt({ options: [{ label: "x".repeat(81) }] })).success,
    false,
  )
  assert.equal(
    chatQuestionSchema.safeParse(withPrompt({ options: [{ label: "ok", description: "x".repeat(257) }] })).success,
    false,
  )
  // A question may not carry an unbounded option list either.
  assert.equal(
    chatQuestionSchema.safeParse(withPrompt({ options: Array.from({ length: 33 }, () => ({ label: "x" })) })).success,
    false,
  )
  assert.equal(
    chatQuestionSchema.parse(withPrompt({ question: "x".repeat(2000) })).questions[0].question.length,
    2000,
  )
})

test("a reply carries one answer per question, in order, never for a rejection", () => {
  for (const [name, body] of Object.entries(fixture.rejectedReplies)) {
    assert.equal(chatRequests["chat.question.reply"].safeParse(body).success, false, name)
  }
  // Indices are bounded to the option cap so a reply cannot address anything else.
  for (const selected of [[32], [-1], [1.5], Array.from({ length: 33 }, (_, index) => index)]) {
    assert.equal(
      chatRequests["chat.question.reply"].safeParse({ ...fixture.reply, answers: [{ selected }] }).success,
      false,
      JSON.stringify(selected),
    )
  }
  assert.equal(
    chatRequests["chat.question.reply"].safeParse({ ...fixture.reply, answers: [{ selected: [0, 1] }] }).success,
    true,
  )
  // Free text is bounded the same as a question's own text, and is trimmed.
  assert.equal(
    chatRequests["chat.question.reply"].safeParse({ ...fixture.textReply,
      answers: [{ text: "x".repeat(2001) }] }).success,
    false,
  )
  assert.equal(
    chatRequests["chat.question.reply"].parse({ ...fixture.textReply,
      answers: [{ text: "  padded  " }] }).answers[0].text,
    "padded",
  )
})
