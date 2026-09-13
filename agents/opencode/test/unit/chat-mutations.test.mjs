import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "chat-mutations-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, "workspace"), foreign = path.join(root, "foreign")
  await mkdir(directory); await mkdir(foreign)
  const source = { id: "ses_source", title: "Source", directory, time: { updated: 1 } }
  const fork = { ...source, id: "ses_fork", title: "Source (fork #1)" }
  const calls = []
  const state = { source, fork, statuses: {}, mutated: false, result: undefined, confirmed: undefined }
  const ok = (data) => ({ response: { ok: true, status: 200 }, data })
  const client = { session: {
    get: async (options) => {
      calls.push(["get", options])
      if (state.mutated && state.confirmed) return ok(state.confirmed)
      return ok(options.path.id === source.id ? source : fork)
    },
    status: async (options) => { calls.push(["status", options]); return ok(state.statuses) },
    update: async (options) => {
      calls.push(["update", options]); state.mutated = true
      source.title = options.body.title
      return ok(state.result ?? source)
    },
    fork: async (options) => { calls.push(["fork", options]); state.mutated = true; return ok(state.result ?? fork) },
    abort: async (options) => { calls.push(["abort", options]); return ok(true) },
  } }
  const adapter = new OpenCodeChatAdapter(client, directory)
  const { projects } = await adapter.execute("project.list", {})
  return { root, directory, foreign, adapter, state, client, calls,
    body: { version: 1, projectId: projects[0].id, sessionId: source.id } }
}

for (const operation of ["chat.rename", "chat.fork"]) {
  const input = (f) => ({ ...f.body, ...(operation === "chat.rename" ? { title: "  New title  " } : {}) })
  test(`${operation} calls only its pinned SDK method with canonical context and verifies readback`, async (t) => {
    const f = await fixture(t)
    const response = await f.adapter.execute(operation, input(f))
    assert.deepEqual(response, { version: 1, chat: operation === "chat.rename"
      ? { id: f.state.source.id, title: "New title", updatedAt: 1 }
      : { id: f.state.fork.id, title: f.state.fork.title, updatedAt: 1 } })
    const name = operation === "chat.rename" ? "update" : "fork"
    const mutation = f.calls.find(([method]) => method === name)[1]
    assert.deepEqual(mutation.body, operation === "chat.rename" ? { title: "New title" } : {})
    assert.deepEqual(mutation.path, { id: f.body.sessionId })
    for (const [, options] of f.calls) {
      assert.deepEqual(options.query, { directory: f.directory })
      assert.equal(options.signal, mutation.signal, "One deadline covers validation, status, mutation, and readback")
    }
    assert.equal(f.calls.at(-1)[0], "get")
    assert.equal(f.calls.at(-1)[1].path.id, response.chat.id)
    assert.equal(f.calls.filter(([method]) => method === name).length, 1)
    assert.equal(f.calls.some(([method]) => method === "abort"), false)
  })

  test(`${operation} rejects foreign/child targets and replaced or expired workspaces before mutation`, async (t) => {
    const f = await fixture(t)
    f.state.source.directory = f.foreign
    await assert.rejects(f.adapter.execute(operation, input(f)), { code: "access_denied" })
    f.state.source.directory = f.directory
    f.state.source.parentID = "ses_parent"
    await assert.rejects(f.adapter.execute(operation, input(f)), { code: "access_denied" })
    delete f.state.source.parentID
    await assert.rejects(f.adapter.execute(operation, { ...input(f), projectId: crypto.randomUUID() }), { code: "context_expired" })
    await rm(f.directory, { recursive: true }); await symlink(f.foreign, f.directory)
    await assert.rejects(f.adapter.execute(operation, input(f)), { code: "access_denied" })
    assert.equal(f.state.mutated, false)
  })

  test(`${operation} rejects a mismatched target ID and missing sessions without mutation`, async (t) => {
    const f = await fixture(t)
    f.client.session.get = async () => ({ response: { ok: true }, data: { ...f.state.source, id: "ses_other" } })
    await assert.rejects(f.adapter.execute(operation, input(f)), { code: "access_denied" })
    f.client.session.get = async () => ({ response: { ok: false, status: 404 } })
    await assert.rejects(f.adapter.execute(operation, input(f)), { code: "chat_not_found" })
    assert.equal(f.state.mutated, false)
  })

  test(`${operation} fails uncertain with a fixed error for invalid mutation results and readbacks`, async (t) => {
    const f = await fixture(t)
    const expected = operation === "chat.rename" ? { ...f.state.source, title: "New title" } : f.state.fork
    for (const field of ["result", "confirmed"]) {
      for (const invalid of [
        { ...expected, directory: f.foreign }, { ...expected, parentID: f.state.source.id },
        { ...expected, id: operation === "chat.rename" ? f.state.fork.id : f.state.source.id },
        { ...expected, time: { updated: -1 } },
        ...(operation === "chat.rename" ? [{ ...expected, title: "Not renamed" }] : []),
      ]) {
        f.state.mutated = false; f.state.result = undefined; f.state.confirmed = undefined
        f.state[field] = invalid
        await assert.rejects(f.adapter.execute(operation, input(f)), (error) => {
          assert.equal(error.code, undefined, "Post-dispatch failure must not claim definitive access denial")
          assert.equal(error.message, "OpenCode mutation was not confirmed")
          return true
        })
        assert.equal(f.state.mutated, true)
      }
    }
  })

  test(`${operation} propagates a single SDK deadline and stops after timeout without retry`, async (t) => {
    const f = await fixture(t)
    const controller = new AbortController()
    t.mock.method(AbortSignal, "timeout", () => controller.signal)
    const method = operation === "chat.rename" ? "update" : "fork"
    f.client.session[method] = async ({ signal }) => {
      assert.equal(signal, controller.signal)
      f.state.mutated = true
      controller.abort(new DOMException("Private timeout details", "TimeoutError"))
      return { response: { ok: true }, data: operation === "chat.rename"
        ? { ...f.state.source, title: "New title" } : f.state.fork }
    }
    await assert.rejects(f.adapter.execute(operation, input(f)), { message: "OpenCode mutation was not confirmed" })
    assert.equal(f.state.mutated, true)
    assert.equal(f.calls.filter(([name]) => name === "get").length, operation === "chat.rename" ? 1 : 2)
  })
}

test("fork authoritatively rejects busy/retry and malformed/unavailable status, not just cached client state", async (t) => {
  const f = await fixture(t)
  for (const type of ["busy", "retry"]) {
    f.state.statuses = { [f.body.sessionId]: { type } }
    await assert.rejects(f.adapter.execute("chat.fork", f.body), { code: "chat_busy" })
  }
  for (const status of [null, [], { [f.body.sessionId]: { type: "unknown" } }]) {
    f.state.statuses = status
    await assert.rejects(f.adapter.execute("chat.fork", f.body))
  }
  f.client.session.status = async () => { throw new Error("SDK unavailable") }
  await assert.rejects(f.adapter.execute("chat.fork", f.body))
  assert.equal(f.state.mutated, false)
  f.client.session.status = async () => ({ response: { ok: true }, data: { [f.body.sessionId]: { type: "idle" } } })
  assert.equal((await f.adapter.execute("chat.fork", f.body)).chat.id, f.state.fork.id)
})

test("fork rechecks membership after status; rename does not require idle status", async (t) => {
  const f = await fixture(t)
  f.client.session.status = async () => {
    f.state.source.directory = f.foreign
    return { response: { ok: true }, data: {} }
  }
  await assert.rejects(f.adapter.execute("chat.fork", f.body), { code: "access_denied" })
  assert.equal(f.state.mutated, false)
  f.state.source.directory = f.directory
  f.client.session.status = async () => { throw new Error("Rename must not need status") }
  assert.equal((await f.adapter.execute("chat.rename", { ...f.body, title: "Rename while running" })).chat.title, "Rename while running")
})

test("adapter rejects injected mutation fields and unknown operations without abort fallback", async (t) => {
  const f = await fixture(t)
  for (const [operation, body] of [
    ["chat.rename", { ...f.body, title: " " }], ["chat.rename", { ...f.body, title: "x".repeat(513) }],
    ["chat.rename", { ...f.body, title: "Title", permission: "allow" }],
    ["chat.fork", { ...f.body, messageID: "msg_cutoff" }], ["chat.fork", { ...f.body, version: 2 }],
    ["chat.unknown", f.body], ["session.shell", f.body], ["toString", f.body],
  ]) await assert.rejects(f.adapter.execute(operation, body))
  assert.deepEqual(f.calls, [])
  assert.deepEqual(await f.adapter.execute("chat.abort", f.body), { version: 1, accepted: true })
  assert.equal(f.calls.filter(([method]) => method === "abort").length, 1)
})

test("native fork suffixes are bounded in summaries, without mutating the native title", async (t) => {
  const f = await fixture(t)
  f.state.fork.title = "x".repeat(512) + " (fork #1)"
  assert.equal((await f.adapter.execute("chat.fork", f.body)).chat.title, "x".repeat(512))
  assert.equal(f.state.fork.title.length > 512, true)
})
