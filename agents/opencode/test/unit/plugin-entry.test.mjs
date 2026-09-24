import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import root from "../../index.js"
import rootTui from "../../tui.js"
import server from "../../dist/index.js"
import tui from "../../dist/tui.js"

// OpenCode's loader requires a definition object with a string `id` and a `setup` function (it
// rejects a bare function).
test("the server entry is a plugin definition whose setup is inert", () => {
  assert.equal(typeof server, "object")
  assert.equal(typeof server.id, "string")
  assert.ok(server.id.length > 0)
  assert.equal(typeof server.setup, "function")
  assert.equal(server.setup(), undefined, "the server side is inert")
})

test("the tui entry is a plugin definition", () => {
  assert.equal(typeof tui.id, "string")
  assert.ok(tui.id.length > 0)
  assert.equal(typeof tui.setup, "function")
})

// OpenCode resolves a `plugins` entry naming this directory to <directory>/index.js for its
// server host and <directory>/tui.js for its TUI host, reading neither `main` nor `exports`. A
// directory missing the file for a host is skipped there in silence: no log line, no error
// (verified against 2.0.14), so losing either file breaks the plugin with no diagnostic at all.
test("the package root carries both entries OpenCode resolves a directory to", () => {
  assert.equal(root, server, "the server host gets the server definition, whose setup is inert")
  assert.equal(rootTui, tui, "the TUI host gets the tui definition, which is where the connector runs")
})

test("the root entries are published, not just present in the workspace", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
  for (const entry of ["index.js", "tui.js"]) {
    assert.ok(manifest.files.includes(entry), `an unpublished ${entry} would break the plugin for installs only`)
  }
})
