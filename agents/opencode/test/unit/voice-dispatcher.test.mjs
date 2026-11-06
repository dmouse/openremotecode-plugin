import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { decryptRelayEnvelope, encryptRelayPayload, generateConnectorIdentity } from '@openremotecode/protocol'
import { CommandDispatcher } from '../../dist/command-dispatcher.js'
import { ChatAccessError } from '../../dist/chat-adapter.js'

const data = JSON.parse(await readFile(new URL('../../../../protocol/test/fixtures/voice-v1.json', import.meta.url), 'utf8'))
async function setup(t) {
  const connector = (await generateConnectorIdentity()).identity
  const client = (await generateConnectorIdentity()).identity
  let epoch = 'v'.repeat(43), sequence = 0
  const seen = { starts: 0, cancels: 0, audio: [], authorized: [], allowed: true, prompts: 0, available: true, probes: 0 }
  const dispatcher = new CommandDispatcher({ connectorIdentity: connector, trustedClient: client.publicIdentity,
    sessions: { listSessions: async () => [] }, chats: {
      execute: async () => { seen.prompts++; return { version: 1, accepted: true } },
      authorizeVoice: async (target) => {
        seen.authorized.push(target)
        if (!seen.allowed) throw new ChatAccessError('access_denied')
      },
    }, voice: { available: async (signal) => {
      seen.probes++; seen.signal = signal
      return seen.pending ?? seen.available
    }, start: async () => {
      seen.starts++
      return { append: async (audio) => seen.audio.push([...audio]),
        finish: async () => data.transcript.text, cancel: async () => { seen.cancels++ } }
    } } })
  dispatcher.setEpoch(epoch)
  t.after(() => dispatcher.dispose())
  async function frame(operation, body, sender = client) {
    return encryptRelayPayload({ sender, recipient: connector.publicIdentity, epoch, sequence: sequence++,
      payload: { protocolVersion: 2, kind: 'request', requestId: crypto.randomUUID(), sentAt: Date.now(), operation, body } })
  }
  async function request(operation, body) {
    const result = await dispatcher.handle(await frame(operation, body))
    return decryptRelayEnvelope({ recipient: client, sender: connector.publicIdentity, envelope: result, epoch })
  }
  return { dispatcher, seen, frame, request,
    open: (envelope) => decryptRelayEnvelope({ recipient: client, sender: connector.publicIdentity, envelope, epoch }),
    reconnect() { epoch = 'w'.repeat(43); sequence = 0; dispatcher.setEpoch(epoch) } }
}

test('status is encrypted, read-only, strictly validated and available only to the pinned peer', async (t) => {
  const f = await setup(t)
  assert.ok(f.dispatcher.capabilities.includes('voice.status'))
  const foreign = (await generateConnectorIdentity()).identity
  assert.equal(await f.dispatcher.handle(await f.frame('voice.status', data.status, foreign)), undefined)
  assert.equal(f.seen.probes, 0)
  assert.equal((await f.request('voice.status', { ...data.status, url: 'http://attacker.invalid' })).body.code, 'invalid_request')
  assert.deepEqual((await f.request('voice.status', data.status)).body, data.available)
  f.seen.available = false
  assert.deepEqual((await f.request('voice.status', data.status)).body, data.unavailable)
  assert.equal(f.seen.starts, 0)
  assert.equal(f.seen.prompts, 0)
  assert.deepEqual(f.seen.authorized, [])
})

test('a status probe from an old epoch is aborted and never becomes a fresh availability response', async (t) => {
  const f = await setup(t)
  let release
  f.seen.pending = new Promise((resolve) => { release = resolve })
  const response = f.dispatcher.handle(await f.frame('voice.status', data.status))
  while (!f.seen.signal) await new Promise((resolve) => setImmediate(resolve))
  f.reconnect()
  assert.equal(f.seen.signal.aborted, true)
  release(true)
  const result = await response
  assert.equal(result.epoch, 'w'.repeat(43))
  // The old request can only return a fixed encrypted expiry error in the new epoch.
  const error = await f.open(result)
  assert.equal(error.operation, 'protocol.error')
  assert.equal(error.body.code, 'voice_expired')
  f.seen.pending = undefined
  assert.deepEqual((await f.request('voice.status', data.status)).body, data.available)
})

test('paired E2EE audio returns a transcript without executing any OpenCode command', async (t) => {
  const f = await setup(t)
  assert.ok(f.dispatcher.capabilities.includes('voice.start'))
  assert.deepEqual((await f.request('voice.start', data.start)).body, data.ready)
  assert.deepEqual((await f.request('voice.audio', data.audio)).body, data.ack)
  assert.deepEqual(f.seen.audio, [[0, 0]])
  assert.deepEqual((await f.request('voice.finish', data.finish)).body, data.transcript)
  assert.equal(f.seen.prompts, 0)
  assert.ok(f.seen.authorized.length >= 3)
})

test('foreign keys, invalid audio, arbitrary routes and revoked folders fail closed', async (t) => {
  const f = await setup(t)
  const foreign = (await generateConnectorIdentity()).identity
  assert.equal(await f.dispatcher.handle(await f.frame('voice.start', data.start, foreign)), undefined)
  assert.equal(f.seen.starts, 0)
  assert.equal((await f.request('voice.start', { ...data.start, url: 'http://attacker.invalid' })).body.code, 'invalid_request')
  f.seen.allowed = false
  assert.equal((await f.request('voice.start', data.start)).body.code, 'access_denied')
  assert.equal(f.seen.starts, 0)
  f.seen.allowed = true
  await f.request('voice.start', data.start)
  assert.equal((await f.request('voice.audio', { ...data.audio, audio: 'AAA=' })).body.code, 'invalid_request')
  f.seen.allowed = false
  assert.equal((await f.request('voice.finish', data.finish)).body.code, 'access_denied')
  assert.equal(f.seen.cancels, 1)
})

test('duplicate frames never append twice; fresh-envelope duplicate audio closes the stream', async (t) => {
  const f = await setup(t)
  await f.request('voice.start', data.start)
  const frame = await f.frame('voice.audio', data.audio)
  await f.dispatcher.handle(frame)
  assert.equal(await f.dispatcher.handle(frame), undefined)
  assert.equal((await f.request('voice.audio', data.audio)).body.code, 'voice_expired')
  assert.equal(f.seen.audio.length, 1)
  assert.equal(f.seen.cancels, 1)
})

test('one stream per peer; cancellation and epoch replacement release it', async (t) => {
  const f = await setup(t)
  await f.request('voice.start', data.start)
  assert.equal((await f.request('voice.start', { ...data.start, voiceId: crypto.randomUUID() })).body.code, 'voice_busy')
  assert.deepEqual((await f.request('voice.cancel', data.finish)).body, data.cancelled)
  await f.request('voice.start', data.start)
  f.reconnect()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.seen.cancels, 2)
  assert.equal((await f.request('voice.audio', data.audio)).body.code, 'voice_expired')
})
