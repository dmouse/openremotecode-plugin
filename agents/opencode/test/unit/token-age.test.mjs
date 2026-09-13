import assert from "node:assert/strict"
import test from "node:test"
import { tokenAge } from "../../dist/token-age.js"

test("link age handles recent links, singular/plural units, and clock skew", () => {
  const now = Date.parse("2026-09-05T12:00:00Z")
  for (const [seconds, expected] of [[-60, "just now"], [0, "just now"], [59, "just now"],
    [60, "1 minute ago"], [120, "2 minutes ago"], [3600, "1 hour ago"],
    [7200, "2 hours ago"], [86400, "1 day ago"], [259200, "3 days ago"]]) {
    assert.equal(tokenAge(new Date(now - seconds * 1000).toISOString(), now), expected)
  }
})
