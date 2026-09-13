import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { chatResponses } from "@openremotecode/protocol"
import { LiveParts } from "../../dist/live-parts.js"
const fixture = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/session-next-activity-v1.json", import.meta.url), "utf8"))
const baseline = () => ({ version: 1, chat: { id: fixture.sessionId, title: "Fixture", updatedAt: 1000 }, status: "idle", cursor: null, messages: [] })
const options = { includeActivities: true, includeTools: true, includeShell: true }

test("next start renders an empty running thought before persistence, streams deltas and completes", () => {
  const live = new LiveParts(fixture.sessionId)
  live.remember(baseline(), 0)
  live.capture(fixture.events[0]); live.capture(fixture.events[1])
  const first = live.project(baseline(), options)
  chatResponses['chat.snapshot'].parse(first)
  assert.equal(first.status, 'busy')
  assert.equal(first.messages[0].parts[0].text, '')
  assert.equal(first.messages[0].parts[0].activity.state, 'running')
  const id = first.messages[0].parts[0].id
  live.capture(fixture.events[2]); live.capture(fixture.events[2]); live.capture(fixture.events[3])
  const partial = live.project(baseline(), options).messages[0].parts[0]
  assert.equal(partial.id, id)
  assert.equal(partial.text, 'Inspecting the fixture')
  for (const event of fixture.events.slice(4)) live.capture(event)
  const last = live.project(baseline(), options)
  chatResponses['chat.snapshot'].parse(last)
  assert.equal(last.status, 'idle')
  assert.equal(last.messages[0].text, 'Hello world\n')
  assert.equal(last.messages[0].parts[0].activity.state, 'completed')
  assert.equal(last.messages[0].parts[0].id, id)
  assert.equal(JSON.stringify(last).includes('NOT_FOR_RELAY'), false)
})

test("mixed legacy/next families do not duplicate text and final snapshots replace temporary IDs", () => {
  const live = new LiveParts(fixture.sessionId)
  const legacy = { id: 'native-reasoning', sessionID: 'session', messageID: 'assistant', type: 'reasoning', text: 'Inspecting', time: { start: 1001 } }
  live.capture({ type: 'message.part.updated', properties: { part: legacy } })
  for (const event of fixture.events.slice(0, 4)) live.capture(event)
  const base = baseline()
  base.messages = [{ id: 'assistant', role: 'assistant', text: '', truncated: false,
    parts: [{ id: legacy.id, type: 'reasoning', text: legacy.text }] }]
  assert.equal(live.project(base, options).messages[0].parts.length, 1)
  for (const event of fixture.events.slice(4)) live.capture(event)
  live.overlay('assistant', [{ ...legacy, text: 'Inspecting the fixture', time: { start: 1001, end: 1010 } }], true)
  base.messages[0].parts[0].text = 'Inspecting the fixture'
  live.remember(base, live.snapshotRevision, ['assistant'])
  const final = live.project(base, options)
  assert.equal(final.messages[0].parts.length, 1)
  assert.equal(final.messages[0].parts[0].id, legacy.id)
})

test("native lifecycle does not require clocks, is bounded and rejects foreign or malformed deltas", () => {
  const live = new LiveParts('session')
  const start = structuredClone(fixture.events[1]); delete start.properties.timestamp
  live.capture(start)
  assert.equal(live.project(baseline(), options).messages[0].parts[0].activity.state, 'running')
  live.capture({ ...fixture.events[2], properties: { ...fixture.events[2].properties, sessionID: 'foreign' } })
  live.capture({ ...fixture.events[2], properties: { ...fixture.events[2].properties, delta: {} } })
  assert.equal(live.project(baseline(), options).messages[0].parts[0].text, '')
  live.capture({ ...fixture.events[2], properties: { ...fixture.events[2].properties, delta: 'x'.repeat(100000) } })
  const result = live.project(baseline(), options)
  chatResponses['chat.snapshot'].parse(result)
  assert.equal(result.messages[0].parts[0].text.length, 48000)
  assert.equal(result.messages[0].truncated, true)
  live.capture({ type: 'session.next.step.failed', properties: { sessionID: 'session', assistantMessageID: 'assistant', error: { message: 'NOT_FOR_RELAY' } } })
  assert.equal(live.project(baseline(), options).messages[0].parts[0].activity.state, 'failed')
  live.clear()
  assert.equal(live.project(baseline(), options).messages.length, 0)
})
