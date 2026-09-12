import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, IMAGE_DATA_MAX, chatRequests, chatResponses, chatMessagePartSchema } from "../dist/index.js"

const fixture = JSON.parse(await readFile(new URL("./fixtures/chat-image-v1.json", import.meta.url), "utf8"))
const part = fixture.response.messages[0].parts[0]

test("image previews require explicit opt-in and are independent of tools/shell", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.images"))
  assert.equal(Object.hasOwn(chatRequests, "chat.images"), false)
  for (const operation of ["chat.snapshot", "chat.subtask.snapshot"]) {
    const request = { version: 1, projectId: "00000000-0000-4000-8000-000000000001", sessionId: "ses_image",
      ...(operation === "chat.subtask.snapshot" ? { parentSessionId: "ses_parent" } : {}) }
    chatRequests[operation].parse({ ...request, includeImages: true })
    chatRequests[operation].parse({ ...request, includeShell: true, includeTools: true, includeImages: true })
    assert.equal(chatRequests[operation].safeParse({ ...request, includeImages: "true" }).success, false)
    chatResponses[operation].parse(fixture.response)
  }
})

test("image parts are strict, bounded, always JPEG, and never carry the original file", () => {
  assert.equal(chatMessagePartSchema.safeParse(part).success, true)
  for (const image of [
    { ...part.image, mime: "image/png" },
    { ...part.image, data: "" },
    { ...part.image, data: "not base64!!" },
    { ...part.image, data: "A".repeat(IMAGE_DATA_MAX + 1) },
    { ...part.image, width: 0 },
    { ...part.image, height: -1 },
    { ...part.image, width: 8193 },
    { ...part.image, url: "https://example.test/original.jpg" }, // no such field is accepted
  ]) {
    assert.equal(chatMessagePartSchema.safeParse({ ...part, image }).success, false)
  }
  assert.equal(chatMessagePartSchema.safeParse({ ...part, text: "not empty" }).success, false)
})

test("image data counts toward the shared 48,000-unit message budget", () => {
  const response = structuredClone(fixture.response)
  const message = response.messages[0]
  const budget = 48000 - message.parts[0].image.data.length
  message.parts.push({ id: "extra", type: "text", text: "t".repeat(budget + 1) })
  message.text = "t".repeat(budget + 1)
  assert.equal(chatResponses["chat.snapshot"].safeParse(response).success, false)
  message.parts[1].text = "t".repeat(budget)
  message.text = "t".repeat(budget)
  chatResponses["chat.snapshot"].parse(response)
})

test("a user message may carry text and image parts but never tool/subtask/reasoning parts", () => {
  chatResponses["chat.snapshot"].parse({
    version: 1, chat: fixture.response.chat, status: "idle", cursor: null,
    messages: [fixture.userResponse],
  })
  const withTool = structuredClone(fixture.userResponse)
  withTool.parts.push({ id: "sneaky", type: "tool", text: "",
    tool: { operation: "tool", status: "unknown" } })
  assert.equal(chatResponses["chat.snapshot"].safeParse({
    version: 1, chat: fixture.response.chat, status: "idle", cursor: null, messages: [withTool],
  }).success, false)
})
