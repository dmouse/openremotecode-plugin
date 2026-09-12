import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { CHAT_CAPABILITIES, chatRequests, chatResponses, modelSummarySchema } from "../dist/index.js"

const fixtures = JSON.parse(await readFile(new URL("./fixtures/chat-model-v1.json", import.meta.url), "utf8"))

test("chat.models request accepts only a bounded project reference", () => {
  for (const request of fixtures.list.valid) {
    assert.deepEqual(chatRequests["chat.models"].parse(request), request)
    for (const key of ["version", "projectId"]) {
      const missing = { ...request }; delete missing[key]
      assert.equal(chatRequests["chat.models"].safeParse(missing).success, false)
    }
  }
  for (const override of fixtures.list.invalidOverrides) {
    assert.equal(chatRequests["chat.models"].safeParse({ ...fixtures.list.valid[0], ...override }).success, false)
  }
})

test("chat.models response bounds each model summary and optional effort levels", () => {
  for (const model of fixtures.list.validModels) assert.deepEqual(modelSummarySchema.parse(model), model)
  for (const model of fixtures.list.invalidModels) assert.equal(modelSummarySchema.safeParse(model).success, false)
  const response = { version: 1, models: fixtures.list.validModels }
  assert.deepEqual(chatResponses["chat.models"].parse(response), response)
})

test("chat.prompt accepts a bounded model + effort choice", () => {
  for (const request of fixtures.promptModel.valid) {
    assert.deepEqual(chatRequests["chat.prompt"].parse(request), request)
  }
  for (const override of fixtures.promptModel.invalidOverrides) {
    assert.equal(chatRequests["chat.prompt"].safeParse({ ...fixtures.promptModel.valid[0], ...override }).success, false)
  }
})

test("chat.snapshot response optionally reports the model + effort the last assistant reply used", () => {
  const { base, valid, invalid } = fixtures.snapshotModel
  for (const model of valid) {
    const response = { ...base, model }
    assert.deepEqual(chatResponses["chat.snapshot"].parse(response), response)
    assert.deepEqual(chatResponses["chat.subtask.snapshot"].parse(response), response)
  }
  assert.deepEqual(chatResponses["chat.snapshot"].parse(base), base)
  for (const model of invalid) {
    assert.equal(chatResponses["chat.snapshot"].safeParse({ ...base, model }).success, false)
  }
})

test("chat.models is a real operation; chat.prompt.model is a marker, never an operation", () => {
  assert.ok(CHAT_CAPABILITIES.includes("chat.models"))
  assert.ok(Object.hasOwn(chatRequests, "chat.models"))
  assert.ok(Object.hasOwn(chatResponses, "chat.models"))
  assert.ok(CHAT_CAPABILITIES.includes("chat.prompt.model"))
  assert.equal(Object.hasOwn(chatRequests, "chat.prompt.model"), false)
  assert.equal(Object.hasOwn(chatResponses, "chat.prompt.model"), false)
})
