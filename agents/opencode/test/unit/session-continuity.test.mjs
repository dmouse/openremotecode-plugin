import assert from "node:assert/strict"
import test from "node:test"
import { SessionContinuity } from "../../dist/opencode/session-continuity.js"

const workspace = { id: "project", path: "/work/project", name: "project", dev: 1, ino: 2 }
const session = (id) => ({ id, location: { directory: workspace.path } })

test("continuity has a hard bound without evicting active bindings, and deletion frees capacity", () => {
  const continuity = new SessionContinuity()
  for (let i = 0; i < 2048; i++) continuity.remember(session(`ses_${i}`), workspace)
  assert.throws(() => continuity.ensureRoom(), { code: "context_expired" })
  assert.throws(() => continuity.remember(session("ses_overflow"), workspace), { code: "context_expired" })
  continuity.remember(session("ses_0"), workspace)
  assert.equal(continuity.knows("ses_0", workspace), true)
  continuity.forget("ses_1")
  continuity.remember(session("ses_new"), workspace)
  assert.equal(continuity.knows("ses_new", workspace), true)
})

test("move notifications schedule known identities only and never authorize their payloads", () => {
  const continuity = new SessionContinuity()
  continuity.remember(session("ses_1"), workspace)
  continuity.moved("ses_unknown")
  assert.deepEqual(continuity.candidates(workspace), [])
  continuity.moved("ses_1")
  assert.deepEqual(continuity.candidates(workspace), ["ses_1"])
  assert.equal(continuity.knows("ses_1", { ...workspace, id: "foreign-project" }), false)
  continuity.forget("ses_1")
  assert.deepEqual(continuity.candidates(workspace), [])
})
