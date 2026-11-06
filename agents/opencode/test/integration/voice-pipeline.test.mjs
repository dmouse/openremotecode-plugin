import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { decryptRelayEnvelope, encryptRelayPayload, generateConnectorIdentity } from '@openremotecode/protocol'
import { CommandDispatcher } from '../../dist/command-dispatcher.js'
import { HexVoiceEngine } from '../../dist/voice/hex-engine.js'

test('encrypted voice to Hex HTTP to text to the normal OpenCode prompt path', async (t) => {
  const fixture = JSON.parse(await readFile(new URL('../../../../protocol/test/fixtures/voice-v1.json', import.meta.url), 'utf8'))
  const note = JSON.parse(await readFile(new URL('../../../../protocol/test/fixtures/voice-note-v2.json', import.meta.url), 'utf8'))
  const token = 'hex_synthetic_test_token', ownerToken = 'hex_synthetic_stream_token'
  const routes = [], prompts = []
  const server = createServer(async (request, response) => {
    routes.push(request.url)
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    if (request.url === '/health' || request.url === '/capabilities') {
      assert.equal(request.method, 'GET')
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(
        request.url === '/health' ? { version: '3.3.0', apiVersion: '2' } : { streams: true }))
      return
    }
    const parts = []
    for await (const part of request) parts.push(part)
    const body = Buffer.concat(parts)
    assert.equal(Number(request.headers['content-length']), body.length)
    if (request.url === '/streams') {
      assert.deepEqual(JSON.parse(body), { sampleRate: 16000, sampleFormat: 's16le' })
      response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 1, ownerToken, sampleRate: 16000, sampleFormat: 's16le',
      }))
      return
    }
    assert.equal(request.headers['x-hex-stream-token'], ownerToken)
    if (request.url === '/streams/1/audio') {
      assert.deepEqual(body, Buffer.alloc(2))
      response.writeHead(204).end()
    } else if (request.url === '/streams/1/finish') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: note.transcript }))
    } else { response.writeHead(404).end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const connector = (await generateConnectorIdentity()).identity, client = (await generateConnectorIdentity()).identity
  const dispatcher = new CommandDispatcher({ connectorIdentity: connector, trustedClient: client.publicIdentity,
    sessions: { listSessions: async () => [] }, chats: {
      authorizeVoice: async (target) => { assert.equal(target.projectId, fixture.start.projectId) },
      execute: async (operation, body) => {
        assert.equal(operation, 'chat.prompt')
        prompts.push(body)
        return { version: 1, accepted: true }
      },
    }, voice: new HexVoiceEngine(async () => ({ port: server.address().port, token, apiVersion: '2' })) })
  const epoch = 'p'.repeat(43)
  dispatcher.setEpoch(epoch)
  t.after(() => dispatcher.dispose())
  let sequence = 0
  async function request(operation, body, requestId = crypto.randomUUID()) {
    const frame = await encryptRelayPayload({ sender: client, recipient: connector.publicIdentity, epoch, sequence: sequence++,
      payload: { protocolVersion: 2, kind: 'request', requestId, sentAt: Date.now(), operation, body } })
    assert.equal(JSON.stringify(frame).includes(token), false)
    assert.equal(JSON.stringify(frame).includes(note.transcript), false)
    assert.equal(JSON.stringify(frame).includes('Open Remote Code voice note'), false)
    const result = await dispatcher.handle(frame)
    assert.equal(JSON.stringify(result).includes(note.transcript), false)
    return decryptRelayEnvelope({ recipient: client, sender: connector.publicIdentity, envelope: result, epoch })
  }
  assert.deepEqual((await request('voice.status', fixture.status)).body, fixture.available)
  assert.equal(prompts.length, 0)
  assert.deepEqual((await request('voice.start', fixture.start)).body, fixture.ready)
  await request('voice.audio', fixture.audio)
  const result = await request('voice.finish', fixture.finish)
  assert.deepEqual(result.body, { ...fixture.transcript, text: note.transcript })
  assert.equal(prompts.length, 0) // A quick note has no authority to execute a prompt.
  // Mobile retains only duration and text, not a playable recording. The exact
  // shared marker survives the normal encrypted, authorized, deduplicated path.
  assert.equal(note.prompt, `[Open Remote Code voice note v2: ${note.id}; durationMs=${note.durationMs}]\n${result.body.text}`)
  const body = { version: 1, projectId: fixture.start.projectId, sessionId: fixture.start.sessionId, text: note.prompt }
  const requestId = crypto.randomUUID()
  await request('chat.prompt', body, requestId)
  await request('chat.prompt', body, requestId)
  assert.deepEqual(prompts, [body])
  assert.deepEqual(routes, ['/health', '/capabilities', '/streams', '/streams/1/audio', '/streams/1/finish'])
  await new Promise((resolve) => server.close(resolve))
  assert.deepEqual((await request('voice.status', fixture.status)).body, fixture.unavailable)
})
