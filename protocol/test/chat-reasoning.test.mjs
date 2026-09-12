import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { chatResponses } from "../dist/index.js"

const { response } = JSON.parse(await readFile(new URL("./fixtures/chat-reasoning-v1.json", import.meta.url), "utf8"))
const schema = chatResponses["chat.snapshot"]
const valid = (message) => schema.safeParse({ ...response, messages: [message] }).success
const message = response.messages[0]

test("version 1 snapshots support ordered reasoning and existing text-only peers", () => {
  assert.deepEqual(schema.parse(response), response)
  const { parts: _parts, ...legacy } = message
  assert.equal(valid(legacy), true)
  for (const time of [undefined, { start: 0 }, { start: 0, end: 0 }]) {
    assert.equal(valid({ ...legacy, text: "", parts: [{ id: "r", type: "reasoning", text: "", ...(time ? { time } : {}) }] }), true)
  }
})

test("hostile part types, clocks, duplicates, metadata and conflicting fallback fail", () => {
  const base = { ...message, text: "" }
  const reasoning = { id: "r", type: "reasoning", text: "synthetic" }
  for (const part of [
    { ...reasoning, type: "shell" }, { ...reasoning, metadata: { signature: "synthetic" } },
    { ...reasoning, text: "x".repeat(48001) }, { ...reasoning, time: null },
    ...[{ start: -1 }, { start: 1.5 }, { end: 1 }, { start: 2, end: 1 },
      { start: 0, end: null }, { start: 0, end: 9007199254740992 },
      { start: 0, metadata: {} }].map((time) => ({ ...reasoning, time })),
  ]) assert.equal(valid({ ...base, parts: [part] }), false)
  for (const parts of [null, [reasoning, reasoning],
    Array.from({ length: 101 }, (_, i) => ({ ...reasoning, id: `${i}` })),
    [{ ...reasoning, text: "x".repeat(24001) }, { ...reasoning, id: "other", text: "x".repeat(24000) }],
  ]) assert.equal(valid({ ...base, parts }), false)
  assert.equal(valid({ ...message, role: "user" }), false)
  assert.equal(valid({ ...message, text: "different" }), false)
})
