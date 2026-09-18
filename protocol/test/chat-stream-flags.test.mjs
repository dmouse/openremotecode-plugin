import assert from "node:assert/strict"
import test from "node:test"
import { chatRequests, chatStreamRequests } from "../dist/index.js"

/**
 * A live subscription is a standing chat.snapshot, so the two must accept the same
 * content flags. They drifted once: includeQuestions was added to chat.snapshot for the
 * remote question feature but not to chat.stream.subscribe, and because the subscribe
 * schema is strict, every subscribe the client sent was rejected as invalid_request.
 * Streaming silently died and the client fell back to polling, so answers only appeared
 * once the model had finished. This asserts the shape rather than one field name, so the
 * next flag someone adds to a snapshot cannot break streaming the same way.
 */
const contentFlags = (schema) => Object.keys(schema._def?.shape ?? schema.shape ?? {})
  .filter((key) => key.startsWith("include")).sort()

const unwrap = (schema) => schema.def?.innerType ?? schema._def?.schema ?? schema

test("chat.stream.subscribe accepts every content flag chat.snapshot does", () => {
  const snapshot = contentFlags(unwrap(chatRequests["chat.snapshot"]))
  const subscribe = contentFlags(unwrap(chatStreamRequests["chat.stream.subscribe"]))
  assert.ok(snapshot.length > 0, "no content flags were found on chat.snapshot")
  assert.deepEqual(subscribe, snapshot)
})

test("a subscribe carrying every content flag is accepted", () => {
  const body = {
    version: 1,
    projectId: "11111111-1111-4111-8111-111111111111",
    sessionId: "session",
    subscriptionId: "22222222-2222-4222-8222-222222222222",
  }
  for (const flag of contentFlags(unwrap(chatRequests["chat.snapshot"]))) body[flag] = true
  const parsed = chatStreamRequests["chat.stream.subscribe"].safeParse(body)
  assert.ok(parsed.success, `subscribe rejected a full flag set: ${JSON.stringify(parsed.error?.issues)}`)
})

test("an unknown flag is still rejected", () => {
  assert.equal(chatStreamRequests["chat.stream.subscribe"].safeParse({
    version: 1,
    projectId: "11111111-1111-4111-8111-111111111111",
    sessionId: "session",
    subscriptionId: "22222222-2222-4222-8222-222222222222",
    includeSomethingElse: true,
  }).success, false)
})
