import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { voiceRequests, voiceResponses } from '../dist/index.js'

const fixture = JSON.parse(await readFile(new URL('./fixtures/voice-v1.json', import.meta.url), 'utf8'))
test('voice contract fixes audio format, size, ordering and explicit operations', () => {
  for (const [operation, request, response] of [
    ['voice.status', fixture.status, fixture.available],
    ['voice.start', fixture.start, fixture.ready], ['voice.audio', fixture.audio, fixture.ack],
    ['voice.finish', fixture.finish, fixture.transcript], ['voice.cancel', fixture.finish, fixture.cancelled],
  ]) {
    assert.deepEqual(voiceRequests[operation].parse(request), request)
    assert.deepEqual(voiceResponses[operation].parse(response), response)
    assert.equal(voiceRequests[operation].safeParse({ ...request, version: 2 }).success, false)
    assert.equal(voiceRequests[operation].safeParse({ ...request, url: 'http://external.invalid' }).success, false)
  }
  for (const audio of ['AA', 'A', 'AAA=', 'AAB', Buffer.alloc(16002).toString('base64url')]) {
    assert.equal(voiceRequests['voice.audio'].safeParse({ ...fixture.audio, audio }).success, false)
  }
  assert.equal(voiceRequests['voice.audio'].safeParse({ ...fixture.audio, sequence: -1 }).success, false)
  assert.equal(voiceResponses['voice.finish'].safeParse({ ...fixture.transcript, text: 'x'.repeat(32001) }).success, false)
  assert.deepEqual(voiceResponses['voice.status'].parse(fixture.unavailable), fixture.unavailable)
  assert.equal(voiceResponses['voice.status'].safeParse({ version: 1, available: 'true' }).success, false)
  assert.equal(voiceResponses['voice.status'].safeParse({ ...fixture.available, token: 'secret' }).success, false)
})
