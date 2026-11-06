import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { ChatListStreams } from "../../dist/chat-list-stream.js"

const target = {version: 1, subscriptionId: "22222222-2222-4222-8222-222222222222",
  projectIds: ["11111111-1111-4111-8111-111111111111"]}
const change = {projectId: target.projectIds[0], chat: {id: "session", title: "Chat", updatedAt: 1000,
  activity: {status: "idle", idleAt: 1000, outcome: "succeeded"}}}
function fixture(t) {
  const state = {changed: undefined, reads: [], updates: [], closed: [], reading: undefined, sending: undefined, saturated: false}
  const reader = {
    watch: async (_projects, signal, changed) => {
      state.changed = changed
      await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}))
    },
    read: async (_projects, ids) => { state.reads.push([...ids]); return state.reading ?? [change] },
  }
  const streams = new ChatListStreams(reader, async (update) => {
    state.updates.push(update)
    if (state.sending) await state.sending
    return !state.saturated
  }, async (target) => { state.closed.push(target) })
  t.after(() => streams.dispose())
  return {state, reader, streams}
}

test("list metadata coalesces bursts, bounds IDs, and renews without another watcher", async (t) => {
  const {state, streams} = fixture(t)
  assert.equal(streams.subscribe(target).revision, 0)
  for (let n = 0; n < 40; n++) state.changed("session")
  await delay(200)
  assert.deepEqual(state.reads, [["session"]])
  assert.equal(streams.subscribe(target).revision, 1)
  assert.deepEqual(state.updates[0].changes, [change])
  for (let n = 0; n < 100; n++) state.changed(`ses_${n}`)
  await delay(200)
  assert.equal(state.updates[1].reset, true)
  assert.deepEqual(state.reads[1], [])
  assert.throws(() => streams.unsubscribe({...target, projectIds: [crypto.randomUUID()]}), {code: "access_denied"})
})

test("unsubscribe suppresses in-flight reads and backpressure never queues another read", async (t) => {
  const {state, streams} = fixture(t)
  let release
  state.reading = new Promise((resolve) => { release = resolve })
  streams.subscribe(target)
  state.changed("session")
  await delay(200)
  streams.unsubscribe(target)
  release([change])
  await delay(20)
  assert.equal(state.updates.length, 0)

  state.reading = undefined
  let sent
  state.sending = new Promise((resolve) => { sent = resolve })
  streams.subscribe(target)
  state.changed("session")
  await delay(200)
  const count = state.reads.length
  for (let n = 0; n < 100; n++) state.changed("session")
  await delay(200)
  assert.equal(state.reads.length, count)
  state.saturated = true
  sent()
  await delay(20)
  state.changed("session")
  await delay(200)
  assert.equal(state.reads.length, count)
})

test("lease expiry and watcher reservations remain bounded across relay replacements", async (t) => {
  t.mock.timers.enable({apis: ["setTimeout"]})
  const {state, streams, reader} = fixture(t)
  streams.subscribe(target)
  t.mock.timers.tick(60_000)
  await Promise.resolve()
  assert.equal(state.closed.length, 1)
  // Native watchers that ignore cancellation cannot be multiplied by new relays.
  reader.watch = async () => new Promise(() => {})
  const a = new ChatListStreams(reader, async () => true, async () => {})
  const b = new ChatListStreams(reader, async () => true, async () => {})
  const c = new ChatListStreams(reader, async () => true, async () => {})
  t.after(() => {a.dispose(); b.dispose(); c.dispose()})
  // Let the original responsive watcher release its reservation first.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  a.subscribe(target); a.dispose()
  b.subscribe(target); b.dispose()
  assert.throws(() => c.subscribe(target), {code: "context_expired"})
})

test("cancelled uncooperative reads retain shared capacity until they actually settle", async (t) => {
  t.mock.timers.enable({apis: ["setTimeout"]})
  const {state, streams, reader} = fixture(t)
  let release
  state.reading = new Promise((resolve) => { release = resolve })
  const relays = [streams, new ChatListStreams(reader, async () => true, async () => {}),
    new ChatListStreams(reader, async () => true, async () => {})]
  t.after(() => relays.forEach((relay) => relay.dispose()))
  for (const relay of relays) {
    relay.subscribe(target)
    state.changed("session")
    t.mock.timers.tick(150)
    await new Promise((resolve) => setImmediate(resolve))
    relay.dispose()
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(state.reads.length, 2)
  release([change])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.updates.length, 0, "late cancelled reads must never emit")
})
