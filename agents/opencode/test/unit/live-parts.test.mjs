import assert from "node:assert/strict"
import test from "node:test"
import { LiveParts } from "../../dist/live-parts.js"
import { chatMessageContent } from "../../dist/chat-message.js"
const part = { id: "part", messageID: "message", sessionID: "session", type: "text", text: "" }
const delta = (text) => ({ type: "message.part.delta", properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: text } })
test("live deltas are bounded and snapshots replace them without duplicating text", () => {
  const live = new LiveParts("session")
  live.capture({ type: "message.part.updated", properties: { part: { ...part, metadata: { secret: "private" } } } })
  live.capture(delta("Hello")); live.capture(delta(" world"))
  assert.equal(live.overlay("message", [part])[0].text, "Hello world")
  assert.equal(live.incomplete("message"), false)
  assert.equal(live.parts.get("part").metadata, undefined)
  live.capture({ type: "message.part.updated", properties: { part: { ...part, text: "Hello world!" } } })
  assert.equal(live.overlay("message", [part])[0].text, "Hello world!")
  live.capture(delta("x".repeat(100000)))
  assert.equal(live.parts.get("part").text.length, 48001)
  assert.equal(chatMessageContent("assistant", live.overlay("message", [part])).truncated, true)
})
test("mid-generation subscriptions mark an unavailable prefix until a complete source update", () => {
  const live = new LiveParts("session")
  live.overlay("message", [part])
  live.capture(delta("suffix"))
  assert.equal(live.incomplete("message"), true)
  live.capture({ type: "message.part.updated", properties: { part: { ...part, text: "prefix suffix" } } })
  assert.equal(live.incomplete("message"), false)
  assert.equal(live.overlay("message", [part])[0].text, "prefix suffix")
})
test("synthetic, foreign, unknown and non-text event fields never widen the projection", () => {
  const live = new LiveParts("session")
  live.capture(delta("unknown"))
  assert.equal(live.parts.size, 0)
  live.capture({ type: "message.part.updated", properties: { part: { ...part, synthetic: true } } })
  live.capture(delta("private attachment"))
  assert.equal(chatMessageContent("user", live.overlay("message", [part])).text, "")
  live.capture({ ...delta("foreign"), properties: { ...delta("foreign").properties, sessionID: "foreign" } })
  assert.equal(live.parts.get("part").text, "private attachment")
  live.capture({ ...delta("private"), properties: { ...delta("private").properties, field: "metadata" } })
  assert.equal(live.parts.get("part").text, "private attachment")
})
