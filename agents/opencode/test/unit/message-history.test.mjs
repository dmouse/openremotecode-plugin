import assert from "node:assert/strict"
import test from "node:test"
import { readMessageHistory } from "../../dist/message-history.js"
import { chatMessageContent } from "../../dist/chat-message.js"

test("mixed-engine pagination anchors partial pages while new messages arrive", async () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ id: `m${index}`, type: 'user', text: `Body ${index}`, time: { created: index + 1 } }))
  const stores = { legacy: entries.filter((_, i) => i % 2 === 0), next: entries.filter((_, i) => i % 2 === 1) }
  const legacy = (m) => ({ info: { id: m.id, sessionID: 'session', role: 'user', time: m.time },
    parts: [{ id: `p-${m.id}`, type: 'text', sessionID: 'session', messageID: m.id, text: m.text }] })
  const client = { session: {
    messages: async ({ url, query }) => {
      const source = url ? 'next' : 'legacy'
      const before = Number(query.cursor ?? query.before ?? Infinity)
      if (query.cursor) assert.equal(query.order, undefined)
      const remaining = stores[source].filter((m) => m.time.created < before).sort((a, b) => b.time.created - a.time.created)
      const page = remaining.slice(0, 10)
      const cursor = remaining.length > 10 ? String(page.at(-1).time.created) : undefined
      return url ? { data: { data: page, cursor: cursor ? { next: cursor } : {} }, response: new Response(null) }
        : { data: page.map(legacy).reverse(), response: new Response(null, { headers: cursor ? { 'x-next-cursor': cursor } : {} }) }
    },
    message: async ({ url, path }) => {
      const source = url ? 'next' : 'legacy'
      const message = stores[source].find((m) => m.id === path.messageID)
      assert.equal(path.id, 'session')
      return { data: url ? { data: message } : legacy(message), response: new Response(null) }
    },
  } }
  let result = await readMessageHistory(client, '/workspace', 'session', undefined, new AbortController().signal)
  const ids = result.messages.map((m) => m.info.id)
  assert.deepEqual(ids, entries.slice(20).map((m) => m.id))
  assert.equal(result.cursor.includes('Body'), false)
  stores.next.push({ id: 'new', type: 'user', text: 'New message', time: { created: 1000 } })
  while (result.cursor) {
    result = await readMessageHistory(client, '/workspace', 'session', result.cursor, new AbortController().signal)
    ids.unshift(...result.messages.map((m) => m.info.id))
  }
  assert.deepEqual(ids, entries.map((m) => m.id))
  assert.equal(new Set(ids).size, 30)
})

test("next history uses the presentation allowlist, not provider metadata or non-shell tool output", async () => {
  const message = { id: 'assistant', type: 'assistant', time: { created: 1, completed: 4 },
    metadata: { secret: 'PRIVATE' }, content: [
      { id: 'r', type: 'reasoning', text: 'Review', providerMetadata: { secret: 'PRIVATE' }, time: { created: 1, completed: 2 } },
      { id: 'read', type: 'tool', name: 'read', time: { created: 2, completed: 3 },
        state: { status: 'completed', input: { filePath: 'a.dart' }, content: [{ type: 'text', text: 'PRIVATE' }], structured: { secret: 'PRIVATE' } } },
      { id: 't', type: 'text', text: 'Answer' },
    ] }
  const client = { session: { messages: async ({ url }) => ({ data: url ? { data: [message], cursor: {} } : [], response: new Response(null) }) } }
  const result = await readMessageHistory(client, '/workspace', 'session', undefined, new AbortController().signal)
  const projected = chatMessageContent('assistant', result.messages[0].parts, undefined, { includeTools: true, includeActivities: true })
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false)
  assert.equal(projected.parts[0].activity.state, 'completed')
  assert.equal(projected.parts[1].tool.description, 'a.dart')
})

test("next engine's ModelRef is normalized to the same flat modelID/providerID/variant fields the legacy engine already carries", async () => {
  const message = { id: 'assistant', type: 'assistant', time: { created: 1, completed: 4 },
    model: { id: 'gpt-5.6-sol', providerID: 'openai', variant: 'high' }, content: [{ id: 't', type: 'text', text: 'Answer' }] }
  const client = { session: { messages: async ({ url }) => ({ data: url ? { data: [message], cursor: {} } : [], response: new Response(null) }) } }
  const result = await readMessageHistory(client, '/workspace', 'session', undefined, new AbortController().signal)
  assert.deepEqual({ modelID: result.messages[0].info.modelID, providerID: result.messages[0].info.providerID,
    variant: result.messages[0].info.variant }, { modelID: 'gpt-5.6-sol', providerID: 'openai', variant: 'high' })
})

test("a next engine model without a variant carries no variant field, and a malformed model carries neither", async () => {
  const noVariant = { id: 'a1', type: 'assistant', time: { created: 1 }, model: { id: 'claude', providerID: 'anthropic' }, content: [] }
  const malformed = { id: 'a2', type: 'assistant', time: { created: 2 }, model: 'claude/anthropic', content: [] }
  const client = { session: { messages: async ({ url }) =>
    ({ data: url ? { data: [noVariant, malformed], cursor: {} } : [], response: new Response(null) }) } }
  const result = await readMessageHistory(client, '/workspace', 'session', undefined, new AbortController().signal)
  assert.deepEqual({ modelID: result.messages[0].info.modelID, providerID: result.messages[0].info.providerID,
    variant: result.messages[0].info.variant }, { modelID: 'claude', providerID: 'anthropic', variant: undefined })
  assert.deepEqual({ modelID: result.messages[1].info.modelID, providerID: result.messages[1].info.providerID },
    { modelID: undefined, providerID: undefined })
})
