import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkspaceRegistry } from '../../dist/chat/workspace.js'
import { FileFolderApprovalStore } from '../../dist/folder-approvals.js'
import { OpenCodeChatAdapter } from '../../dist/opencode/chat-adapter.js'

test('voice uses approved projects and root sessions, and rechecks approval after native reads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'voice-authorization-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const foreign = join(root, 'foreign')
  await mkdir(foreign)
  const store = new FileFolderApprovalStore(join(root, 'private', 'approved-folders'))
  const approved = await store.inspect(root)
  await store.setEnabled(approved, true)
  const registry = new WorkspaceRegistry(undefined, [], () => store.list())
  let revoke = false, reads = 0
  const client = { session: { get: async ({ sessionID }) => {
    reads++
    if (revoke) await store.setEnabled(approved, false)
    return { id: sessionID, title: 'Voice chat', time: { created: 1, updated: 1 },
      ...(sessionID === 'child' ? { parentID: 'root' } : {}),
      location: { directory: sessionID === 'foreign' ? foreign : root } }
  } } }
  const adapter = new OpenCodeChatAdapter(client, root, [], registry)
  const { projects: [project] } = await adapter.execute('project.list', {})
  const target = { version: 1, projectId: project.id, voiceId: crypto.randomUUID() }
  const signal = new AbortController().signal
  await adapter.authorizeVoice(target, signal) // A new-chat quick note needs no native session.
  assert.equal(reads, 0)
  await adapter.authorizeVoice({ ...target, sessionId: 'root' }, signal)
  await assert.rejects(adapter.authorizeVoice({ ...target, sessionId: 'child' }, signal), { code: 'access_denied' })
  await assert.rejects(adapter.authorizeVoice({ ...target, sessionId: 'foreign' }, signal), { code: 'access_denied' })
  revoke = true
  await assert.rejects(adapter.authorizeVoice({ ...target, sessionId: 'root' }, signal), { code: 'context_expired' })
  const before = reads
  await assert.rejects(adapter.authorizeVoice(target, signal), { code: 'context_expired' })
  assert.equal(reads, before)
})
