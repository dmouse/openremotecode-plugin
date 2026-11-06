import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { chatSummarySchema, chatRequests, chatListStreamRequests, chatListUpdatedSchema } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/chat-activity-v1.json", import.meta.url), "utf8"))
test("shared activity metadata is bounded, optional and presentation-only", () => {
  for (const summary of fixture.summaries) assert.deepEqual(chatSummarySchema.parse(summary), summary)
  for (const activity of fixture.invalidActivity) {
    assert.equal(chatSummarySchema.safeParse({ ...fixture.summaries[0], activity }).success, false)
  }
  assert.deepEqual(chatRequests["chat.view"].parse(fixture.view), fixture.view)
  for (const patch of [{idleAt: -1}, {idleAt: 1.1}, {idleAt: Number.MAX_SAFE_INTEGER + 1}, {directory: "/private"}]) {
    assert.equal(chatRequests["chat.view"].safeParse({...fixture.view, ...patch}).success, false)
  }
})
test("list subscriptions scope normalized summaries and bound fanout", () => {
  const target = {version: 1, subscriptionId: "22222222-2222-4222-8222-222222222222", projectIds: [fixture.projectId]}
  assert.deepEqual(chatListStreamRequests["chat.list.subscribe"].parse(target), target)
  assert.equal(chatListStreamRequests["chat.list.subscribe"].safeParse({...target, projectIds: [fixture.projectId, fixture.projectId]}).success, false)
  const update = {...target, revision: 1, reset: false, changes: [{projectId: fixture.projectId, chat: fixture.summaries[0]}]}
  assert.deepEqual(chatListUpdatedSchema.parse(update), update)
  assert.equal(chatListUpdatedSchema.safeParse({...update, changes: Array(51).fill(update.changes[0])}).success, false)
  assert.equal(chatListUpdatedSchema.safeParse({...update, projectIds: ["33333333-3333-4333-8333-333333333333"]}).success, false)
})
