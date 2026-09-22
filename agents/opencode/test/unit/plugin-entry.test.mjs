import assert from "node:assert/strict"
import test from "node:test"
import server from "../../dist/index.js"
import tui from "../../dist/tui.js"

// OpenCode 1.x and 2.x load the same entry files. v1 reads `server` / `tui`; v2 requires a
// definition object with a string `id` and a `setup` function (its loader rejects a bare function).
test("the server entry satisfies both the v1 and the v2 loader", () => {
  assert.equal(typeof server, "object")
  assert.equal(typeof server.id, "string")
  assert.ok(server.id.length > 0)
  assert.equal(typeof server.server, "function", "v1 server hook")
  assert.equal(typeof server.setup, "function", "v2 setup")
  assert.equal("tui" in server, false, "v1 rejects a module that exports both server and tui")
  assert.equal(server.setup(), undefined, "the v2 server side is inert")
})

test("the tui entry satisfies both the v1 and the v2 loader", () => {
  assert.equal(typeof tui.id, "string")
  assert.equal(typeof tui.tui, "function", "v1 tui hook")
  assert.equal(typeof tui.setup, "function", "v2 setup")
  assert.equal("server" in tui, false, "v1 rejects a module that exports both server and tui")
})
