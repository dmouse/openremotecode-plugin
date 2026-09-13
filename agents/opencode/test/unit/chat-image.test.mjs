import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { boundedMessageParts, chatMessageContent, resolveImages } from "../../dist/chat-message.js"

const images = JSON.parse(await readFile(new URL("../../../../protocol/test/fixtures/chat-image-v1.json", import.meta.url), "utf8"))

test("resolveImages decodes an inline attachment for either role into a small, dimensioned JPEG preview", async () => {
  const shot = await resolveImages(images.nativeParts)
  const photo = await resolveImages(images.userNativeParts)
  for (const [source, id] of [[shot, "shot"], [photo, "photo"]]) {
    const image = source.get(id)
    assert.equal(image.mime, "image/jpeg")
    const bytes = Buffer.from(image.data, "base64")
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]) // JPEG magic bytes
    assert.ok(image.width > 0 && image.height > 0)
    assert.ok(image.data.length <= 34000)
  }
  // The unrelated non-image attachment never becomes an image entry.
  assert.equal((await resolveImages(images.userNativeParts)).has("notes"), false)
})

test("only an inline, mime-matched, allowlisted data URL is ever decoded; nothing is fetched", async () => {
  const cases = [
    { id: "a", type: "file", mime: "image/svg+xml", url: "data:image/svg+xml;base64,PHN2Zy8+" },
    { id: "b", type: "file", mime: "image/png", url: "https://example.test/x.png" },
    { id: "c", type: "file", mime: "image/png", url: "file:///etc/passwd" },
    // Declared mime disagrees with the data URL's own mime prefix.
    { id: "d", type: "file", mime: "image/jpeg", url: images.nativeParts[0].url },
    { id: "e", type: "file", mime: "image/png", url: "data:image/png;base64,not-base64!!" },
  ]
  const resolved = await resolveImages(cases)
  assert.equal(resolved.size, 0)
})

test("a corrupt or empty inline payload fails closed to today's label/exclusion fallback", async () => {
  const corrupt = [{ id: "bad", type: "file", filename: "broken.png", mime: "image/png",
    url: "data:image/png;base64,AAAA" }]
  const resolved = await resolveImages(corrupt)
  assert.equal(resolved.has("bad"), false)
  assert.deepEqual(chatMessageContent("user", corrupt), { text: "[File: broken.png]\n", truncated: false })
  assert.deepEqual(chatMessageContent("assistant", corrupt), { text: "", truncated: false })
})

test("chatMessageContent presents an already-resolved image for either role and excludes it from message.text", async () => {
  const shot = await resolveImages(images.nativeParts)
  const assistant = chatMessageContent("assistant", images.nativeParts, undefined, { images: shot })
  assert.equal(assistant.text, "")
  assert.equal(assistant.truncated, false)
  assert.equal(assistant.parts.length, 1)
  assert.equal(assistant.parts[0].type, "image")
  assert.equal(assistant.parts[0].text, "")
  assert.equal(assistant.parts[0].image.mime, "image/jpeg")

  const photo = await resolveImages(images.userNativeParts)
  const user = chatMessageContent("user", images.userNativeParts, undefined, { images: photo })
  assert.equal(user.text, "Here's a screenshot\n[File: notes.txt]\n")
  assert.equal(user.parts.map((p) => p.type).join(","), "text,image,text")
  assert.equal(user.parts[1].id, "photo")

  // Without the images map (capability not negotiated), behavior is unchanged.
  assert.deepEqual(chatMessageContent("assistant", images.nativeParts), { text: "", truncated: false })
})

test("a resolved image that no longer fits the remaining budget falls back and marks truncated", () => {
  const part = { id: "shot", type: "file", filename: "screenshot.png", mime: "image/png", url: images.nativeParts[0].url }
  const oversized = new Map([["shot", { mime: "image/jpeg", data: "A".repeat(49000), width: 1, height: 1 }]])
  const result = chatMessageContent("user", [part], undefined, { images: oversized })
  assert.equal(result.truncated, true)
  assert.equal(result.text, "[File: screenshot.png]\n")
  const assistantResult = chatMessageContent("assistant", [part], undefined, { images: oversized })
  assert.deepEqual(assistantResult, { text: "", truncated: true })
})

test("boundedMessageParts drops a whole image that no longer fits, never truncating its bytes", () => {
  const fitting = { id: "img", type: "image", text: "", image: { mime: "image/jpeg", data: "x".repeat(100), width: 1, height: 1 } }
  const filler = { id: "t", type: "text", text: "t".repeat(47950) }
  const overflow = boundedMessageParts([filler, fitting])
  assert.equal(overflow.parts.some((p) => p.id === "img"), false)
  assert.equal(overflow.truncated, true)
  const fits = boundedMessageParts([fitting, filler])
  assert.ok(fits.parts.some((p) => p.id === "img"))
  assert.equal(fits.text.includes("img"), false)
})
