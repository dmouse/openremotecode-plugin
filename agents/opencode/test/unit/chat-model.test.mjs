import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"

test("chat.models maps the native provider list into bounded summaries, reporting each model's own effort variant ids", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-models-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  let queried
  const providers = [
    { id: "openai", name: "OpenAI", models: {
      // `variants` is a record keyed by variant id on OpenCode 1.18.30 (confirmed
      // against a live `GET /config/providers` response), not an array -- only
      // the keys (a >10 overflow here, capped) ever cross into effortLevels.
      "gpt-5": { id: "gpt-5", name: "GPT-5", capabilities: { reasoning: true }, options: {},
        variants: { none: { reasoningEffort: "none" }, low: { reasoningEffort: "low" },
          medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" },
          xhigh: { reasoningEffort: "xhigh" }, v6: {}, v7: {}, v8: {}, v9: {}, v10: {}, v11: {} } },
    } },
    { id: "anthropic", name: "Anthropic", models: {
      "claude": { id: "claude", name: "Claude", capabilities: { reasoning: false }, options: {} },
    } },
  ]
  const client = { config: { providers: async (options) => { queried = options; return { data: { providers }, response: { ok: true } } } } }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  const { models } = await adapter.execute("chat.models", { projectId: projects[0].id })
  assert.deepEqual(models, [
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-5", modelName: "GPT-5",
      effortLevels: ["none", "low", "medium", "high", "xhigh", "v6", "v7", "v8", "v9", "v10"] },
    { providerID: "anthropic", providerName: "Anthropic", modelID: "claude", modelName: "Claude" },
  ])
  assert.deepEqual(queried.query, { directory: root })
  assert.ok(queried.signal instanceof AbortSignal)
})

test("chat.models ignores malformed variant data rather than leaking or crashing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-models-malformed-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const providers = [
    { id: "openai", name: "OpenAI", models: {
      "gpt-5": { id: "gpt-5", name: "GPT-5", variants: "not-an-object" },
      "gpt-4": { id: "gpt-4", name: "GPT-4", variants: ["array-not-record"] },
      "gpt-3": { id: "gpt-3", name: "GPT-3", variants: null },
      "o1": { id: "o1", name: "o1", variants: { ok: {}, "": {} } },
    } },
  ]
  const client = { config: { providers: async () => ({ data: { providers }, response: { ok: true } }) } }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  const { models } = await adapter.execute("chat.models", { projectId: projects[0].id })
  assert.deepEqual(models, [
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-5", modelName: "GPT-5" },
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-4", modelName: "GPT-4" },
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-3", modelName: "GPT-3" },
    { providerID: "openai", providerName: "OpenAI", modelID: "o1", modelName: "o1", effortLevels: ["ok"] },
  ])
})

test("chat.models falls back to an empty list rather than leaking a native failure", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-models-fail-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const client = { config: { providers: async () => { throw new Error("native failure") } } }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  assert.deepEqual(await adapter.execute("chat.models", { projectId: projects[0].id }), { version: 1, models: [] })
})

test("chat.prompt forwards a validated model and effort as a top-level variant, and refuses an effort the model does not report", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "chat-prompt-model-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = { id: "ses_fixture", directory: root }
  const calls = []
  const providers = [
    { id: "openai", name: "OpenAI", models: {
      "gpt-5": { id: "gpt-5", name: "GPT-5", variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } } },
    } },
  ]
  const client = {
    config: { providers: async () => ({ data: { providers }, response: { ok: true } }) },
    session: {
      get: async () => ({ data: session, response: { ok: true } }),
      promptAsync: async (options) => { calls.push(options); return { response: new Response(null, { status: 204 }) } },
    },
  }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  const body = { version: 1, projectId: projects[0].id, sessionId: session.id, text: "Synthetic prompt" }
  const model = { providerID: "openai", modelID: "gpt-5" }

  assert.deepEqual(await adapter.execute("chat.prompt", { ...body, model }), { version: 1, accepted: true })
  assert.deepEqual(calls.at(-1).body, { parts: [{ type: "text", text: body.text }], model })

  assert.deepEqual(await adapter.execute("chat.prompt", { ...body, model: { ...model, effort: "high" } }),
    { version: 1, accepted: true })
  assert.deepEqual(calls.at(-1).body, { parts: [{ type: "text", text: body.text }], model, variant: "high" })

  await assert.rejects(adapter.execute("chat.prompt", { ...body, model: { ...model, effort: "extreme" } }))
  assert.equal(calls.length, 2, "The refused effort request must never reach the native prompt call")
})

async function snapshotAdapter(t, messages, { legacyHeaders = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "chat-snapshot-model-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = { id: "ses_fixture", title: "Fixture", directory: root, time: { updated: 1 } }
  const client = {
    session: {
      get: async () => ({ data: session, response: { ok: true } }),
      status: async () => ({ data: {}, response: { ok: true } }),
      messages: async ({ url }) => url
        ? { data: { data: [], cursor: {} }, response: { ok: true } }
        : { data: messages, response: new Response(null, { headers: legacyHeaders }) },
    },
  }
  const adapter = new OpenCodeChatAdapter(client, root)
  const { projects } = await adapter.execute("project.list", {})
  return { adapter, body: { version: 1, projectId: projects[0].id, sessionId: session.id } }
}

test("chat.snapshot recovers the last assistant reply's model + effort on the unpaginated latest page", async (t) => {
  const { adapter, body } = await snapshotAdapter(t, [
    { info: { id: "m1", role: "user", sessionID: "ses_fixture" }, parts: [] },
    { info: { id: "m2", role: "assistant", sessionID: "ses_fixture", modelID: "gpt-5.6-sol", providerID: "openai", variant: "high" }, parts: [] },
  ])
  assert.deepEqual((await adapter.execute("chat.snapshot", body)).model,
    { providerID: "openai", modelID: "gpt-5.6-sol", effort: "high" })
})

test("chat.snapshot omits effort for a model with none, and omits model entirely with no assistant reply yet", async (t) => {
  const { adapter: withModel, body: modelBody } = await snapshotAdapter(t,
    [{ info: { id: "m1", role: "assistant", sessionID: "ses_fixture", modelID: "claude", providerID: "anthropic" }, parts: [] }])
  assert.deepEqual((await withModel.execute("chat.snapshot", modelBody)).model, { providerID: "anthropic", modelID: "claude" })

  const { adapter: userOnly, body: userBody } = await snapshotAdapter(t,
    [{ info: { id: "m1", role: "user", sessionID: "ses_fixture" }, parts: [] }])
  assert.equal((await userOnly.execute("chat.snapshot", userBody)).model, undefined)
})

test("chat.snapshot omits the recovered model on an earlier-history (paginated) page", async (t) => {
  // A truthy x-next-cursor makes readMessageHistory report more history, so
  // the adapter mints a real opaque cursor -- reusing it for a second call
  // is what actually drives `before` away from undefined, not a guessed shape.
  const { adapter, body } = await snapshotAdapter(t,
    [{ info: { id: "m1", role: "assistant", sessionID: "ses_fixture", modelID: "gpt-5.6-sol", providerID: "openai" }, parts: [] }],
    { legacyHeaders: { "x-next-cursor": "earlier" } })
  const latest = await adapter.execute("chat.snapshot", body)
  assert.ok(latest.model, "the latest page must still recover a model")
  assert.ok(latest.cursor, "a truthy native cursor must produce an opaque one to page further")
  const older = await adapter.execute("chat.snapshot", { ...body, cursor: latest.cursor })
  assert.equal(older.model, undefined)
})
