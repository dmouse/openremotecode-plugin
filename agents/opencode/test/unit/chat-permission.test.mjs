import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { permissionSummary } from "../../dist/chat-message.js"

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
