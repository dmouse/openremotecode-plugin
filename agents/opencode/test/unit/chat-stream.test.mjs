import assert from "node:assert/strict"
import { setImmediate as immediate } from "node:timers/promises"
import test from "node:test"
import { ChatStreams } from "../../dist/chat-stream.js"
import { activityFor } from "../../dist/activity-adapter.js"
const target = { version: 1, projectId: "11111111-1111-4111-8111-111111111111", sessionId: "session",
  subscriptionId: "22222222-2222-4222-8222-222222222222" }
const snapshot = (text = "hello") => ({ version: 1, chat: { id: "session", title: "Stream", updatedAt: 1000 },
  status: "busy", cursor: null, messages: [{ id: "message", role: "assistant", text, truncated: false }] })
const flush = async () => { for (let i = 0; i < 8; i++) await immediate() }
function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const state = { calls: 0, result: snapshot(), events: [], closed: [], changed: undefined, read: undefined, send: undefined, signal: undefined }
  const reader = { readChat: async (_, signal) => { state.calls++; return state.read ? state.read(signal) : state.result },
    watchChat: async (_, signal, changed) => { state.changed = changed; state.signal = signal; changed(false); await new Promise((resolve) => signal.addEventListener("abort", resolve)) } }
  const manager = new ChatStreams(reader, async (update, signal) => {
    state.events.push(update); return state.send ? state.send(signal) : true
  }, async (value) => { state.closed.push(value) })
  t.after(() => manager.dispose())
  return { state, reader, manager, tick: async (ms) => { t.mock.timers.tick(ms); await flush() } }
}
test("adapter classifies known tools without parsing descriptions or leaking inputs", () => {
  for (const [tool, kind] of [["bash", "execute"], ["todowrite", "update_tasks"], ["apply_patch", "apply_patch"], ["custom", "tool"]]) {
    assert.deepEqual(activityFor({ type: "tool", tool, state: { status: "running", input: { secret: "private" } } }), { kind, state: "running" })
  }
  assert.deepEqual(activityFor({ type: "reasoning", time: { start: 1, end: 2 } }), { kind: "reasoning", state: "completed" })
  assert.deepEqual(activityFor({ type: "reasoning", time: { start: 1 } }, true), { kind: "reasoning", state: "unknown" })
})
test("event-driven stream is idle without changes, coalesces bursts and sends changed messages only", async (t) => {
  const f = setup(t)
  assert.equal((await f.manager.subscribe(target)).revision, 0)
  await f.tick(3000)
  assert.equal(f.state.calls, 1)
  f.state.result = snapshot("hello world")
  for (let i = 0; i < 1000; i++) f.state.changed(false)
  await f.tick(99); assert.equal(f.state.calls, 1)
  await f.tick(1); assert.equal(f.state.calls, 2)
  assert.equal(f.state.events.length, 1)
  assert.equal(f.state.events[0].snapshot.messages[0].text, "hello world")
  f.state.changed(false)
  await f.tick(100)
  assert.equal(f.state.events.length, 1)
  f.state.result = { ...f.state.result, status: "idle" }
  f.state.changed(false)
  await f.tick(100)
  assert.deepEqual(f.state.events[1].snapshot.messages, [])
  assert.equal(f.state.events[1].snapshot.status, "idle")
  f.manager.unsubscribe(target)
  assert.equal(f.state.signal.aborted, true)
  const calls = f.state.calls
  await f.tick(60000)
  assert.equal(f.state.calls, calls)
})
test("reset reconciles removals; concurrent reads, backpressure and lease expiry are bounded", async (t) => {
  const f = setup(t)
  await f.manager.subscribe(target)
  f.state.result = { ...snapshot(), messages: [] }
  f.state.changed(true)
  await f.tick(100)
  assert.equal(f.state.events[0].reset, true)
  let release
  f.state.read = () => new Promise((resolve) => { release = resolve })
  f.state.changed(false); await f.tick(100)
  for (let i = 0; i < 100; i++) f.state.changed(false)
  const calls = f.state.calls
  await f.tick(2000); assert.equal(f.state.calls, calls)
  assert.equal((await f.manager.subscribe(target)).snapshot.messages.length, 0)
  f.state.read = undefined; release(snapshot("latest")); await flush(); await f.tick(100)
  f.state.send = async () => false
  f.state.result = snapshot("saturated"); f.state.changed(false); await f.tick(100)
  assert.equal(f.state.signal.aborted, true)
  await f.manager.subscribe({ ...target, subscriptionId: crypto.randomUUID() })
  await f.tick(60000)
  assert.equal(f.state.signal.aborted, true)
  assert.equal(f.state.closed.length, 1)
})
test("foreign IDs, malformed responses and disposed reads cannot emit updates", async (t) => {
  const f = setup(t)
  await f.manager.subscribe(target)
  await assert.rejects(f.manager.subscribe({ ...target, sessionId: "foreign" }))
  assert.throws(() => f.manager.unsubscribe({ ...target, projectId: crypto.randomUUID() }))
  f.state.result = { ...snapshot(), chat: { ...snapshot().chat, id: "foreign" } }
  f.state.changed(false); await f.tick(100)
  assert.equal(f.state.events.length, 0)
  assert.equal(f.state.closed.length, 1)
})

test("a renewal overtaking a reset event retains the deletion watermark", async (t) => {
  const f = setup(t)
  await f.manager.subscribe(target)
  let release
  f.state.send = () => new Promise((resolve) => { release = resolve })
  f.state.result = { ...snapshot(), messages: [] }
  f.state.changed(true)
  await f.tick(100)
  const baseline = await f.manager.subscribe(target)
  assert.equal(baseline.revision, 2)
  assert.equal(baseline.resetRevision, 1)
  assert.equal(baseline.reset, false)
  assert.deepEqual(baseline.snapshot.messages, [])
  release(true)
  await flush()
})
