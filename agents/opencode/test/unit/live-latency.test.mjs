import assert from "node:assert/strict"
import { setImmediate as immediate } from "node:timers/promises"
import test from "node:test"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"

test("live text bypasses message/status/subtask rereads while still checking session membership", async () => {
  const directory = process.cwd()
  let stream, snapshots = 0, nextSnapshots = 0, statusReads = 0, sessionReads = 0, changes = 0, foreign = false
  const ok = (data) => ({ data, response: new Response(null) })
  const client = { session: {
    get: async () => {
      sessionReads++
      return ok({ id: 'session', directory: foreign ? '/' : directory, title: 'Fixture', time: { updated: 1 } })
    },
    messages: async ({ url }) => {
      if (url) { nextSnapshots++; assert.equal(nextSnapshots, 1); return ok({ data: [], cursor: {} }) }
      snapshots++; assert.equal(snapshots, 1, 'A text delta must not wait for another full snapshot'); return ok([])
    },
    status: async () => { statusReads++; return ok({}) },
    list: async (options) => {
      assert.equal(options.url, '/event')
      const response = new Response(new ReadableStream({ start(controller) { stream = controller } }),
        { headers: { 'content-type': 'text/event-stream' } })
      return { response }
    },
  } }
  const adapter = new OpenCodeChatAdapter(client, directory)
  const projectId = (await adapter.execute('project.list', { version: 1 })).projects[0].id
  const target = { version: 1, projectId, sessionId: 'session', subscriptionId: crypto.randomUUID(),
    includeActivities: true, includeTools: true, includeSubtasks: true }
  const controller = new AbortController()
  const watching = adapter.watchChat(target, controller.signal, () => changes++)
  const emit = (event) => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
  try {
    while (!stream) await immediate()
    emit({ type: 'server.connected' })
    while (changes < 1) await immediate()
    await adapter.readChat(target, controller.signal, true)
    const readsBefore = sessionReads
    emit({ type: 'session.next.reasoning.started', properties: { sessionID: 'session', assistantMessageID: 'new-message', reasoningID: 'r', timestamp: 1 } })
    emit({ type: 'session.next.reasoning.delta', properties: { sessionID: 'session', assistantMessageID: 'new-message', reasoningID: 'r', delta: 'Live thought' } })
    while (changes < 3) await immediate()
    const result = await adapter.readChat(target, controller.signal)
    assert.equal(result.messages[0].parts[0].text, 'Live thought')
    assert.equal(result.messages[0].parts[0].activity.state, 'running')
    assert.equal(snapshots, 1)
    assert.equal(nextSnapshots, 1)
    assert.equal(statusReads, 1)
    assert.ok(sessionReads > readsBefore, 'Fast delivery must reauthorize the target')
    foreign = true
    await assert.rejects(adapter.readChat(target, controller.signal), (error) => error.code === 'access_denied')
  } finally { controller.abort(); await watching }
})
