import assert from "node:assert/strict"
import test from "node:test"
import { OpenCodeChatAdapter } from "../../dist/chat-adapter.js"
import { createProjectFixture } from "../support/opencode-project-fixture.mjs"

test("pinned OpenCode deletes the authorized chat tree while preserving other sessions", async (t) => {
  const f = await createProjectFixture(t)
  const directory = f.dirs["repo-a"]
  const client = f.client(directory)
  const main = (await client.session.create({ body: { title: "Delete fixture" } })).data
  const child = (await client.session.create({ body: { parentID: main.id, title: "Child fixture" } })).data
  const grandchild = (await client.session.create({ body: { parentID: child.id, title: "Grandchild fixture" } })).data
  const sibling = (await client.session.create({ body: { title: "Keep fixture" } })).data
  const foreign = (await f.client(f.dirs["repo-b"]).session.create({ body: { title: "Foreign fixture" } })).data
  const adapter = new OpenCodeChatAdapter(client, directory)
  const { projects } = await adapter.execute("project.list", {})
  const projectId = projects[0].id
  const foreignChild = (await f.client(f.dirs["repo-b"]).session.create({ body: { parentID: main.id, title: "Foreign child fixture" } })).data
  assert.ok(foreignChild)
  await assert.rejects(adapter.execute("chat.delete", { projectId, sessionId: main.id }), { code: "access_denied" })
  assert.equal((await client.session.get({ path: { id: main.id } })).response.status, 200)
  assert.equal((await f.client(f.dirs["repo-b"]).session.delete({ path: { id: foreignChild.id } })).data, true)
  await assert.rejects(adapter.execute("chat.delete", { projectId, sessionId: foreign.id }), { code: "access_denied" })
  assert.equal((await adapter.execute("chat.get", { projectId, sessionId: main.id })).chat.id, main.id)
  assert.deepEqual(await adapter.execute("chat.delete", { projectId, sessionId: main.id }), { version: 1, deleted: true })
  for (const session of [main, child, grandchild]) {
    assert.equal((await client.session.get({ path: { id: session.id } })).response.status, 404)
  }
  for (const session of [sibling, foreign]) {
    assert.equal((await client.session.get({ path: { id: session.id } })).response.status, 200)
  }
})
