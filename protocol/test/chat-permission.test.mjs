import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatResponses, chatPermissionSchema } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/chat-permission-v1.json", import.meta.url), "utf8"))
const permission = fixture.response.permission

test("permission is opt-in presentation, independent of tools/shell/images, never a callable operation on its own", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.permissions"))
  assert.equal(Object.hasOwn(chatRequests, "chat.permissions"), false)
  for (const operation of ["chat.snapshot", "chat.subtask.snapshot"]) {
    const request = { version: 1, projectId: "00000000-0000-4000-8000-000000000001", sessionId: "ses_permission",
      ...(operation === "chat.subtask.snapshot" ? { parentSessionId: "ses_parent" } : {}) }
    chatRequests[operation].parse({ ...request, includePermissions: true })
    assert.equal(chatRequests[operation].safeParse({ ...request, includePermissions: "true" }).success, false)
    chatResponses[operation].parse(fixture.response)
  }
  // Absent by default: an older/non-opted-in client never sees the field.
  const { permission: _dropped, ...withoutPermission } = fixture.response
  chatResponses["chat.snapshot"].parse(withoutPermission)
  // Explicitly nothing pending is also valid.
  chatResponses["chat.snapshot"].parse({ ...fixture.response, permission: null })
})

test("chat.permission.reply accepts exactly once, always and reject", () => {
  const request = { version: 1, projectId: "00000000-0000-4000-8000-000000000001",
    sessionId: "ses_permission", permissionId: "per_fixture" }
  for (const response of fixture.replies) {
    chatRequests["chat.permission.reply"].parse({ ...request, response })
  }
  assert.deepEqual([...fixture.replies].sort(), ["always", "once", "reject"])
  for (const response of ["forever", "Always", "Once", "", null, undefined, 1]) {
    assert.equal(chatRequests["chat.permission.reply"].safeParse({ ...request, response }).success, false)
  }
  chatResponses["chat.permission.reply"].parse({ version: 1, accepted: true })
  assert.equal(chatResponses["chat.permission.reply"].safeParse({ version: 1, accepted: false }).success, false)
})

test("permission fields are strict and bounded, and never carry raw native metadata", () => {
  assert.equal(chatPermissionSchema.safeParse(permission).success, true)
  for (const invalid of [
    { ...permission, operation: "delete" },
    { ...permission, description: "" },
    { ...permission, description: "d".repeat(257) },
    { ...permission, pattern: "p".repeat(257) },
    { ...permission, metadata: { command: "npm install" } },
    { ...permission, extra: "unexpected" },
  ]) {
    assert.equal(chatPermissionSchema.safeParse(invalid).success, false)
  }
  assert.equal(JSON.stringify(permission).includes("PRIVATE_"), false)
})
