import assert from 'node:assert/strict'
import test from 'node:test'
import { HexVoiceEngine } from '../../dist/voice/hex-engine.js'
import { VoiceSessions } from '../../dist/voice/voice-sessions.js'

const token = 'hex_test_fixture_token', ownerToken = 'hex_test_stream_token'
const ready = { id: 3, ownerToken, sampleRate: 16000, sampleFormat: 's16le' }

test('availability probes only authenticated read-only loopback endpoints and rediscovers Hex', async () => {
  const calls = []
  let port = 12345
  const engine = new HexVoiceEngine(async () => ({ port, token, apiVersion: '2' }), async (url, options) => {
    calls.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    assert.equal(options.body, undefined)
    assert.equal(options.headers['X-Hex-Stream-Token'], undefined)
    return Response.json(url.endsWith('/health') ? { version: '3.3.0', apiVersion: '2' } : { streams: true })
  })
  const signal = new AbortController().signal
  assert.equal(await engine.available(signal), true)
  port = 12346
  assert.equal(await engine.available(signal), true)
  assert.deepEqual(calls, [12345, 12346].flatMap((p) => [
    `http://127.0.0.1:${p}/health`, `http://127.0.0.1:${p}/capabilities`,
  ]))
})

test('missing or invalid discovery, stale ports, bad auth and incompatible responses are unavailable', async () => {
  const signal = new AbortController().signal
  for (const discovery of [async () => { throw new Error('missing file') },
    async () => ({ port: 0, token, apiVersion: '2' }), async () => ({ port: 12345, token, apiVersion: '1' })]) {
    assert.equal(await new HexVoiceEngine(discovery, async () => assert.fail('must not fetch')).available(signal), false)
  }
  const discovery = async () => ({ port: 12345, token, apiVersion: '2' })
  for (const fetcher of [async () => { throw new Error('connection refused') },
    async () => new Response(null, { status: 401 }), async () => new Response(null, { status: 302 }),
    async () => Response.json({ version: '3.3.0', apiVersion: '1' }),
    async () => new Response('not json'), async () => new Response('x'.repeat(256001))]) {
    assert.equal(await new HexVoiceEngine(discovery, fetcher).available(signal), false)
  }
  for (const capabilities of [{ streams: false }, {}, { streams: 'true' }]) {
    const engine = new HexVoiceEngine(discovery, async (url) => Response.json(url.endsWith('/health')
      ? { version: '3.3.0', apiVersion: '2' } : capabilities))
    assert.equal(await engine.available(signal), false)
  }
})

test('availability shares a deadline across health and capabilities and honours cancellation', async () => {
  const controller = new AbortController()
  let healthSignal
  const engine = new HexVoiceEngine(async () => ({ port: 12345, token, apiVersion: '2' }), async (url, options) => {
    if (url.endsWith('/health')) {
      healthSignal = options.signal
      return Response.json({ version: '3.3.0', apiVersion: '2' })
    }
    assert.equal(options.signal, healthSignal)
    controller.abort()
    return Response.json({ streams: true })
  })
  assert.equal(await engine.available(controller.signal), false)
  let calls = 0
  const timeout = new HexVoiceEngine(async () => ({ port: 12345, token, apiVersion: '2' }), async (_, options) => {
    calls++
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)))
  })
  // AbortSignal.timeout is unref'ed; keep the test alive until its deadline.
  const keepAlive = setInterval(() => {}, 10000)
  try { assert.equal(await timeout.available(new AbortController().signal), false) }
  finally { clearInterval(keepAlive) }
  assert.equal(calls, 1)
})

test('concurrent status checks share a probe and disposal aborts it without reserving a stream', async () => {
  let release, probes = 0, signal
  const pending = new Promise((resolve) => { release = resolve })
  const sessions = new VoiceSessions({ available: async (abort) => {
    probes++; signal = abort; return pending
  }, start: async () => assert.fail('status cannot start a stream') }, async () => assert.fail('no project required'))
  const a = sessions.execute('voice.status', { version: 1 })
  const b = sessions.execute('voice.status', { version: 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(probes, 1)
  sessions.dispose()
  assert.equal(signal.aborted, true)
  release(false)
  assert.deepEqual(await a, { version: 1, available: false })
  assert.deepEqual(await b, { version: 1, available: false })
  await sessions.execute('voice.status', { version: 1 })
  assert.equal(probes, 2)
  sessions.dispose()
})

test('Hex supplied-audio requests stay on loopback, authenticate and bound response bodies', async () => {
  const calls = []
  const engine = new HexVoiceEngine(async () => ({ port: 12345, token, apiVersion: '2' }), async (url, options) => {
    calls.push([url, options])
    assert.ok(url.startsWith('http://127.0.0.1:12345/streams'))
    assert.equal(options.headers.Authorization, `Bearer ${token}`)
    assert.equal(options.redirect, 'error')
    if (url.endsWith('/streams')) return Response.json(ready)
    assert.equal(options.headers['X-Hex-Stream-Token'], ownerToken)
    if (url.endsWith('/audio')) {
      assert.equal(options.headers['Content-Length'], '4')
      return new Response(null, { status: 204 })
    }
    return Response.json({ text: ' A test transcript. ' })
  })
  const signal = new AbortController().signal
  const stream = await engine.start(signal)
  await stream.append(new Uint8Array(4), signal)
  assert.equal(await stream.finish(signal), 'A test transcript.')
  await stream.cancel()
  assert.equal(calls.length, 3)
  const oversized = new HexVoiceEngine(async () => ({ port: 12345, token, apiVersion: '2' }), async () =>
    new Response('x'.repeat(256001)))
  await assert.rejects(oversized.start(signal))
})

test('cancelling an opening stream cannot free its slot until startup settles', async () => {
  let release, cancels = 0
  const pending = new Promise((resolve) => { release = resolve })
  const sessions = new VoiceSessions({ start: async () => {
    await pending
    return { append: async () => {}, finish: async () => '', cancel: async () => { cancels++ } }
  } }, async () => {})
  const target = { version: 1, voiceId: crypto.randomUUID(), projectId: crypto.randomUUID() }
  const start = sessions.execute('voice.start', target)
  const rejected = assert.rejects(start)
  await new Promise((resolve) => setImmediate(resolve))
  sessions.dispose()
  await assert.rejects(sessions.execute('voice.start', { ...target, voiceId: crypto.randomUUID() }), /voice_busy/)
  release()
  await rejected
  assert.equal(cancels, 1)
  sessions.dispose()
})
