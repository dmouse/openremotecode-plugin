import assert from "node:assert/strict"
import { setImmediate as immediate } from "node:timers/promises"
import test from "node:test"
import { ChatAccessError } from "../../dist/chat-adapter.js"
import { ProjectMcpSubscriptions, readProjectMcp } from "../../dist/project-mcp.js"

const projectId = "11111111-1111-4111-8111-111111111111"
const subscriptionId = "22222222-2222-4222-8222-222222222222"
const snapshot = (status = "connected") => ({ version: 1, projectId, state: "ready", servers: [{ name: "server", status }] })
const flush = async () => { for (let i = 0; i < 8; i++) await immediate() }
function setup(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 })
  const state = { calls: [], events: [], result: snapshot(), read: undefined, send: undefined }
  const reader = { readProjectMcp: async (id, signal) => {
    state.calls.push({ id, signal })
    return state.read ? state.read(id, signal) : { ...state.result, projectId: id }
  } }
  const manager = new ProjectMcpSubscriptions(reader, async (update, signal) => {
    state.events.push(update)
    return state.send ? state.send(update, signal) : true
  })
  t.after(() => manager.dispose())
  return { manager, reader, state, tick: async (ms) => { t.mock.timers.tick(ms); await flush() } }
}

test("polls only active subscribers, after the prior read, emitting change-only full replacements", async (t) => {
  const f = setup(t)
  await f.tick(3000)
  assert.equal(f.state.calls.length, 0)
  assert.deepEqual(await f.manager.subscribe(projectId, subscriptionId), { ...snapshot(), subscriptionId, revision: 0 })
  await f.tick(2999); assert.equal(f.state.calls.length, 1)
  await f.tick(1); assert.equal(f.state.calls.length, 2)
  assert.equal(f.state.events.length, 0)
  f.state.result = snapshot("disabled")
  await f.tick(3000)
  assert.deepEqual(f.state.events, [{ ...snapshot("disabled"), subscriptionId, revision: 1 }])
  f.state.result = { version: 1, projectId, state: "unavailable", servers: [] }
  await f.tick(3000)
  assert.deepEqual(f.state.events.at(-1), { ...f.state.result, subscriptionId, revision: 2 })
  assert.deepEqual(f.manager.unsubscribe(projectId, subscriptionId), { version: 1, unsubscribed: true })
  const calls = f.state.calls.length
  await f.tick(60_000)
  assert.equal(f.state.calls.length, calls)
})

test("polls and concurrent renewals serialize fresh reads and never reset revisions", async (t) => {
  const f = setup(t)
  await f.manager.subscribe(projectId, subscriptionId)
  let release
  f.state.read = () => new Promise((resolve) => { release = resolve })
  await f.tick(3000)
  const renewal = f.manager.subscribe(projectId, subscriptionId)
  const secondRenewal = f.manager.subscribe(projectId, subscriptionId)
  await f.tick(3000)
  assert.equal(f.state.calls.length, 2, "No overlapping read or repeating poll while the prior read is pending")
  f.state.read = undefined
  f.state.result = snapshot("failed")
  release(snapshot("disabled"))
  assert.deepEqual(await renewal, { ...snapshot("failed"), subscriptionId, revision: 2 })
  assert.equal((await secondRenewal).revision, 3)
  assert.deepEqual(f.state.events, [{ ...snapshot("disabled"), subscriptionId, revision: 1 }])
  await f.tick(2999); assert.equal(f.state.calls.length, 4)
  await f.tick(1); assert.equal(f.state.calls.length, 5)
})

test("lease starts on successful handling, renews for sixty seconds, and expires orphaned clients", async (t) => {
  const f = setup(t)
  let release
  f.state.read = () => new Promise((resolve) => { release = resolve })
  const subscribing = f.manager.subscribe(projectId, subscriptionId)
  await flush(); await f.tick(9000)
  f.state.read = undefined; release(snapshot())
  await subscribing
  await f.tick(30_000)
  assert.equal((await f.manager.subscribe(projectId, subscriptionId)).revision, 1)
  await f.tick(59_999)
  const calls = f.state.calls.length
  await f.tick(1)
  await f.tick(30_000)
  assert.equal(f.state.calls.length, calls)
  for (let i = 0; i < 4; i++) await f.manager.subscribe(projectId, crypto.randomUUID())
})

test("a poll queued behind renewal cancels the renewal timer and still waits three seconds after its read", async (t) => {
  const f = setup(t)
  await f.manager.subscribe(projectId, subscriptionId)
  let releaseRenewal, releasePoll
  f.state.read = () => new Promise((resolve) => { releaseRenewal = resolve })
  const renewal = f.manager.subscribe(projectId, subscriptionId)
  // Fire the prior timer before the queued renewal starts, putting a poll behind it.
  await f.tick(3000)
  assert.equal(f.state.calls.length, 2)
  f.state.read = () => new Promise((resolve) => { releasePoll = resolve })
  releaseRenewal(snapshot())
  await renewal; await flush()
  assert.equal(f.state.calls.length, 3)
  await f.tick(4000)
  assert.equal(f.state.calls.length, 3)
  f.state.read = undefined; releasePoll(snapshot())
  await flush()
  assert.equal(f.state.calls.length, 3, "No stale timer may queue an immediate extra poll")
  await f.tick(2999); assert.equal(f.state.calls.length, 3)
  await f.tick(1); assert.equal(f.state.calls.length, 4)
})

test("four-slot cap includes pending reads and same-ID foreign projects cannot renew or unsubscribe", async (t) => {
  const f = setup(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  f.state.read = () => gate
  const ids = [subscriptionId, ...Array.from({ length: 3 }, () => crypto.randomUUID())]
  const pending = ids.map((id) => f.manager.subscribe(projectId, id))
  await flush()
  await assert.rejects(f.manager.subscribe(projectId, crypto.randomUUID()), { code: "context_expired" })
  await assert.rejects(f.manager.subscribe(crypto.randomUUID(), subscriptionId), { code: "access_denied" })
  assert.throws(() => f.manager.unsubscribe(crypto.randomUUID(), subscriptionId), { code: "access_denied" })
  assert.equal(f.state.calls.length, 4)
  release(snapshot()); await Promise.all(pending)
  f.manager.unsubscribe(projectId, subscriptionId)
  await f.manager.subscribe(projectId, crypto.randomUUID())
})

test("unsubscribe, disposal and lease expiry invalidate in-flight poll/renewal results", async (t) => {
  const f = setup(t)
  for (const mode of ["unsubscribe", "expiry", "dispose"]) {
    await f.manager.subscribe(projectId, subscriptionId)
    if (mode === "expiry") await f.tick(59_000)
    let release
    f.state.read = () => new Promise((resolve) => { release = resolve })
    const pending = f.manager.subscribe(projectId, subscriptionId)
    const rejected = assert.rejects(pending, { code: "context_expired" })
    await flush()
    const signal = f.state.calls.at(-1).signal
    if (mode === "unsubscribe") f.manager.unsubscribe(projectId, subscriptionId)
    if (mode === "expiry") await f.tick(1000)
    if (mode === "dispose") f.manager.dispose()
    await rejected
    assert.equal(signal.aborted, true)
    f.state.read = undefined; release(snapshot("failed"))
    await flush()
    assert.equal(f.state.events.length, 0)
  }
})

test("in-flight poll is cancelled on unsubscribe and a new same-ID subscription is not removed by it", async (t) => {
  const f = setup(t)
  await f.manager.subscribe(projectId, subscriptionId)
  let release
  f.state.read = () => new Promise((resolve) => { release = resolve })
  await f.tick(3000)
  f.manager.unsubscribe(projectId, subscriptionId)
  f.state.read = undefined
  assert.equal((await f.manager.subscribe(projectId, subscriptionId)).revision, 0)
  release(snapshot("disabled")); await flush()
  f.state.result = snapshot("failed")
  await f.tick(3000)
  assert.deepEqual(f.state.events, [{ ...snapshot("failed"), subscriptionId, revision: 1 }])
})

test("read failures sanitize to unavailable, authorization failures terminate the subscription", async (t) => {
  const f = setup(t)
  f.state.read = async () => { throw new Error("synthetic-native-secret") }
  assert.deepEqual(await f.manager.subscribe(projectId, subscriptionId), { version: 1, projectId, subscriptionId,
    revision: 0, state: "unavailable", servers: [] })
  f.state.read = undefined
  await f.tick(3000)
  assert.equal(f.state.events[0].state, "ready")
  f.state.read = async () => { throw new ChatAccessError("access_denied") }
  await f.tick(3000)
  const calls = f.state.calls.length
  await f.tick(3000)
  assert.equal(f.state.calls.length, calls)
  await assert.rejects(f.manager.subscribe(projectId, subscriptionId), { code: "access_denied" })
})

test("one ten-second deadline bounds waiting for an uncooperative reader and suppresses late data", async (t) => {
  const f = setup(t)
  let release
  f.state.read = () => new Promise((resolve) => { release = resolve })
  const pending = readProjectMcp(f.reader, projectId, new AbortController().signal)
  await f.tick(9999)
  assert.equal(f.state.calls[0].signal.aborted, false)
  await f.tick(1)
  assert.deepEqual(await pending, { version: 1, projectId, state: "unavailable", servers: [] })
  assert.equal(f.state.calls[0].signal.aborted, true)
  release(snapshot())
})

test("snapshots, polls and renewals share four outstanding reads until true settlement, not timeout or expiry", async (t) => {
  const f = setup(t)
  const unavailable = { version: 1, projectId, state: "unavailable", servers: [] }
  await f.manager.subscribe(projectId, subscriptionId)
  const underlying = []
  let active = 0, peak = 0
  f.state.read = () => {
    active++; peak = Math.max(peak, active)
    return new Promise((resolve, reject) => { underlying.push({ resolve, reject }) }).finally(() => { active-- })
  }
  t.after(() => { for (const operation of underlying) operation.resolve(snapshot()) })
  await f.tick(3000) // One underlying poll, even after its waiter eventually times out.
  const snapshots = [readProjectMcp(f.reader, projectId, new AbortController().signal),
    readProjectMcp(f.reader, projectId, new AbortController().signal)]
  const secondId = crypto.randomUUID()
  const subscribing = f.manager.subscribe(projectId, secondId)
  await flush()
  assert.equal(underlying.length, 4)
  const saturated = readProjectMcp(f.reader, projectId, new AbortController().signal)
  await flush()
  assert.equal(underlying.length, 4, "Saturation must not start authorization or SDK I/O")
  assert.deepEqual(await saturated, unavailable)
  assert.deepEqual(await readProjectMcp({ readProjectMcp: async () => snapshot() }, projectId,
    new AbortController().signal), snapshot(), "Other adapter instances have independent budgets")
  await f.tick(10_000)
  assert.deepEqual(await Promise.all(snapshots), [unavailable, unavailable])
  assert.deepEqual(await subscribing, { ...unavailable, subscriptionId: secondId, revision: 0 })
  assert.equal(active, 4, "Timeout only releases waiters, not the underlying operations")
  f.manager.unsubscribe(projectId, secondId)

  for (let attempt = 0; attempt < 8; attempt++) {
    assert.equal((await f.manager.subscribe(projectId, subscriptionId)).state, "unavailable")
    await f.tick(3000)
    assert.deepEqual(await readProjectMcp(f.reader, projectId, new AbortController().signal), unavailable)
    await f.tick(60_000) // Expire the lease and create another subscription lifetime.
    assert.equal((await f.manager.subscribe(projectId, subscriptionId)).revision, 0)
    assert.equal(underlying.length, 4)
    assert.equal(active, 4)
  }
  f.manager.dispose()
  const events = f.state.events.length
  underlying[0].resolve(snapshot("disabled"))
  await flush()
  assert.equal(active, 3)
  assert.equal(f.state.events.length, events, "Late data cannot revive a disposed stream")
  const recovering = readProjectMcp(f.reader, projectId, new AbortController().signal)
  await flush()
  assert.equal(underlying.length, 5)
  assert.equal(active, 4)
  assert.deepEqual(await readProjectMcp(f.reader, projectId, new AbortController().signal), unavailable)
  underlying[4].resolve(snapshot())
  assert.deepEqual(await recovering, snapshot())
  underlying[1].reject(new Error("synthetic-late-native-error"))
  await flush()
  assert.equal(active, 2, "Late rejection must also release its reservation without an unhandled rejection")
  f.state.read = undefined
  assert.deepEqual(await readProjectMcp(f.reader, projectId, new AbortController().signal), snapshot())
  assert.equal(peak, 4)
})

test("synchronous failures, rejections and early aborts release read reservations without unhandled rejections", async (t) => {
  setup(t)
  let controller, mode, calls = 0
  const reader = { readProjectMcp() {
    calls++
    if (mode === "throw") throw new Error("synthetic-native-error")
    if (mode === "reject") return Promise.reject(new Error("synthetic-native-error"))
    if (mode === "abort") {
      controller.abort()
      return Promise.reject(new Error("synthetic-aborted-native-error"))
    }
    return Promise.resolve(snapshot())
  } }
  for (mode of ["throw", "reject", "abort", "ready"]) {
    for (let attempt = 0; attempt < 8; attempt++) {
      controller = new AbortController()
      const before = calls
      const result = readProjectMcp(reader, projectId, controller.signal)
      if (mode === "abort") await assert.rejects(result, { code: "context_expired" })
      else assert.deepEqual(await result, mode === "ready" ? snapshot()
        : { version: 1, projectId, state: "unavailable", servers: [] })
      assert.equal(calls, before + 1, "Settled failures must not leak reservations")
    }
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    controller = new AbortController()
    const before = calls
    const result = readProjectMcp(reader, projectId, controller.signal)
    controller.abort() // Before the underlying reader's deferred invocation.
    await assert.rejects(result, { code: "context_expired" })
    assert.equal(calls, before)
    await assert.rejects(readProjectMcp(reader, projectId, controller.signal))
  }
  assert.deepEqual(await readProjectMcp(reader, projectId, new AbortController().signal), snapshot())
  await flush()
})

test("send saturation stops all subscriptions without buffering or retrying events", async (t) => {
  const f = setup(t)
  await f.manager.subscribe(projectId, subscriptionId)
  await f.manager.subscribe(projectId, crypto.randomUUID())
  f.state.result = snapshot("disabled")
  f.state.send = async () => false
  await f.tick(3000)
  const calls = f.state.calls.length, events = f.state.events.length
  await f.tick(60_000)
  assert.equal(f.state.calls.length, calls)
  assert.equal(f.state.events.length, events)
  await assert.rejects(f.manager.subscribe(projectId, subscriptionId), { code: "context_expired" })
})

test("a stalled sender blocks the next read and the renewal queue stays bounded", async (t) => {
  const f = setup(t)
  await f.manager.subscribe(projectId, subscriptionId)
  let release
  f.state.send = () => new Promise((resolve) => { release = resolve })
  f.state.result = snapshot("disabled")
  await f.tick(3000)
  const pending = Array.from({ length: 7 }, () => f.manager.subscribe(projectId, subscriptionId))
  await assert.rejects(f.manager.subscribe(projectId, subscriptionId), { code: "context_expired" })
  await f.tick(3000)
  assert.equal(f.state.calls.length, 2)
  release(true)
  assert.deepEqual((await Promise.all(pending)).map((reply) => reply.revision), [2, 3, 4, 5, 6, 7, 8])
})
