import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { permissionSummary } from "../../dist/chat-message.js"
import { LiveParts } from "../../dist/live-parts.js"

const fixture = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-permission-v1.json", import.meta.url), "utf8"))

test("permissionSummary maps only OpenCode's own prepared fields, never raw metadata", () => {
  assert.deepEqual(permissionSummary(fixture.nativePermission), fixture.response.permission)
  assert.equal(JSON.stringify(permissionSummary(fixture.nativePermission)).includes("PRIVATE_"), false)
})

test("permissionSummary falls back for unknown/unmapped kinds and joins array patterns", () => {
  const unknown = permissionSummary({ ...fixture.nativePermission, permission: "some_mcp_tool" })
  assert.equal(unknown.operation, "tool")
  assert.equal(unknown.description, "Permission requested: some_mcp_tool")
  const blank = permissionSummary({ ...fixture.nativePermission, permission: "" })
  assert.equal(blank.description, "Permission requested")
  const joined = permissionSummary({ ...fixture.nativePermission, patterns: ["a.txt", "b.txt"] })
  assert.equal(joined.pattern, "a.txt, b.txt")
  const none = permissionSummary({ ...fixture.nativePermission, patterns: undefined })
  assert.equal(Object.hasOwn(none, "pattern"), false)
})

test("permissionSummary strips control characters and bidi overrides, and bounds length", () => {
  const result = permissionSummary({ ...fixture.nativePermission, permission: "Run\x1b[31m red‮ text" })
  // eslint-disable-next-line no-control-regex -- asserting control/bidi-override characters were stripped
  assert.equal(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/u.test(result.description), false)
  const long = permissionSummary({ ...fixture.nativePermission, permission: "x".repeat(500) })
  assert.equal(long.description.length, 256)
})

test("LiveParts captures a matching permission.asked and clears on permission.replied", () => {
  const live = new LiveParts("ses_permission")
  assert.equal(live.permission, undefined)
  live.capture({ type: "permission.asked", properties: { id: "other-session", sessionID: "ses_other" } })
  assert.equal(live.permission, undefined, "a different session's request is never captured")
  live.reconcileSoon = false
  live.capture({ type: "permission.asked", properties: fixture.nativePermission })
  assert.deepEqual(live.permission, fixture.nativePermission)
  assert.equal(live.reconcileSoon, true)
  live.reconcileSoon = false
  live.capture({ type: "permission.replied", properties: { sessionID: "ses_permission", permissionID: "per_someone_else" } })
  assert.deepEqual(live.permission, fixture.nativePermission, "a reply to a different request never clears this one")
  assert.equal(live.reconcileSoon, false)
  live.capture({ type: "permission.replied", properties: { sessionID: "ses_permission", permissionID: fixture.nativePermission.id } })
  assert.equal(live.permission, undefined)
  assert.equal(live.reconcileSoon, true)
})

test("LiveParts also accepts the legacy permission.updated event name and the requestID reply field", () => {
  const live = new LiveParts("ses_permission")
  live.capture({ type: "permission.updated", properties: fixture.nativePermission })
  assert.deepEqual(live.permission, fixture.nativePermission)
  live.capture({ type: "permission.replied", properties: { sessionID: "ses_permission", requestID: fixture.nativePermission.id } })
  assert.equal(live.permission, undefined)
})

test("LiveParts.project only ever includes permission when requested, refreshed from the live value", () => {
  const live = new LiveParts("ses_permission")
  live.capture({ type: "permission.asked", properties: fixture.nativePermission })
  const snapshot = { version: 1, chat: fixture.response.chat, status: "idle", cursor: null, messages: [],
    permission: { id: "stale", operation: "tool", description: "Stale remembered value" } }
  const requested = live.project(snapshot, { includePermissions: true })
  assert.deepEqual(requested.permission, fixture.response.permission)
  const notRequested = live.project(snapshot, { includePermissions: false })
  assert.equal(Object.hasOwn(notRequested, "permission"), false, "never carries over a stale remembered value")
})
