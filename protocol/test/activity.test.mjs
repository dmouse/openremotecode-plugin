import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { activitySchema, ACTIVITY_KINDS, ACTIVITY_STATES, chatStreamRequests, chatStreamUpdateSchema } from "../dist/index.js"
const fixture = JSON.parse(await readFile(new URL("./fixtures/activity-v1.json", import.meta.url), "utf8"))
test("agent-neutral schema covers shared activities and strict lifecycle states", () => {
  assert.deepEqual(fixture.activities.map((value) => activitySchema.parse(value).kind), [...ACTIVITY_KINDS])
  for (const state of ACTIVITY_STATES) activitySchema.parse({ kind: "tool", state })
  for (const value of [{ kind: "bash", state: "running" }, { kind: "read", state: "success" },
    { kind: "read", state: "completed", output: "private" }]) assert.equal(activitySchema.safeParse(value).success, false)
})
test("stream targets and revisions are strict and bind the snapshot to its authorized session", () => {
  const { revision: _revision, reset: _reset, snapshot: _snapshot, ...target } = fixture.stream
  chatStreamRequests["chat.stream.subscribe"].parse({ ...target, includeActivities: true })
  chatStreamUpdateSchema.parse(fixture.stream)
  for (const extra of [{ revision: -1 }, { revision: 0.5 }, { revision: 9007199254740992 },
    { sessionId: "foreign" }, { parentSessionId: "foreign" }, { reset: null }, { payload: {} }]) {
    assert.equal(chatStreamUpdateSchema.safeParse({ ...fixture.stream, ...extra }).success, false)
  }
  assert.equal(chatStreamRequests["chat.stream.subscribe"].safeParse({ ...target, command: "injected" }).success, false)
})
