import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import { chatRequests, chatMessagePartSchema, projectMcpServerSchema, utf16Length, voiceResponses } from "../dist/index.js"

test("explicit UTF-16 limits preserve ASCII, astral, combining and unpaired-surrogate boundaries", () => {
  const schema = z.string().check(utf16Length(2, 4))
  for (const value of ["ab", "abcd", "😀", "😀😀", "e\u0301", "\ud800\ud800"]) {
    assert.equal(schema.safeParse(value).success, true, JSON.stringify(value))
  }
  for (const value of ["", "a", "abcde", "😀😀a", "😀😀😀", null, 4, {}]) {
    assert.equal(schema.safeParse(value).success, false, JSON.stringify(value))
  }
  assert.equal(z.string().check(utf16Length(20, 64)).safeParse("😀".repeat(10)).success, true)
  assert.equal(z.string().check(utf16Length(0, 4)).safeParse("").success, true)
})

test("trimmed checks reject blank values and preserve the public rename limit", () => {
  const target = { version: 1, projectId: "00000000-0000-4000-8000-000000000001", sessionId: "session" }
  const rename = (title) => chatRequests["chat.rename"].safeParse({ ...target, title })
  assert.equal(rename("   ").success, false)
  assert.equal(rename("😀".repeat(257)).success, false)
  assert.equal(rename("  " + "😀".repeat(256) + "  ").data.title.length, 512)
  assert.equal(chatRequests["chat.prompt"].safeParse({ ...target, text: "😀".repeat(16001) }).success, false)
})

test("wire text, code, voice and MCP limits remain UTF-16, matching Dart", () => {
  const tool = { id: "code", type: "tool", text: "", tool: { operation: "execute", status: "completed",
    code: { source: "😀".repeat(4000), output: "", truncated: false } } }
  assert.equal(chatMessagePartSchema.safeParse(tool).success, true)
  tool.tool.code.source += "a"
  assert.equal(chatMessagePartSchema.safeParse(tool).success, false)
  assert.equal(chatMessagePartSchema.safeParse({ id: "text", type: "text", text: "😀".repeat(24001) }).success, false)
  const voice = { version: 1, voiceId: "11111111-1111-4111-8111-111111111111", text: "😀".repeat(16000) }
  assert.equal(voiceResponses["voice.finish"].safeParse(voice).success, true)
  assert.equal(voiceResponses["voice.finish"].safeParse({ ...voice, text: voice.text + "a" }).success, false)
  assert.equal(projectMcpServerSchema.safeParse({ name: "😀".repeat(64), status: "connected" }).success, true)
  assert.equal(projectMcpServerSchema.safeParse({ name: "😀".repeat(65), status: "connected" }).success, false)
})
