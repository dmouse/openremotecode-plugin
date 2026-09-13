import assert from "node:assert/strict"
import test from "node:test"

import { configuredServiceOrigin, DEFAULT_SERVICE_ORIGIN, validateLocalRelayURL, validateRelayURL } from "../../dist/service-origin.js"

const development = { OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK: "true" }

test("plugin apiUrl takes precedence over the environment without changing it", () => {
  const environment = { OPENCODE_REMOTE_SERVER_URL: "https://environment.example.test" }
  assert.equal(
    configuredServiceOrigin({ apiUrl: " https://project.example.test/ " }, environment).origin,
    "https://project.example.test",
  )
  assert.equal(environment.OPENCODE_REMOTE_SERVER_URL, "https://environment.example.test")
  assert.equal(
    configuredServiceOrigin({ apiUrl: "https://another.example.test" }, environment).origin,
    "https://another.example.test",
  )
})

test("omitting apiUrl preserves the environment and local development fallbacks", () => {
  assert.equal(
    configuredServiceOrigin({}, { OPENCODE_REMOTE_SERVER_URL: " https://environment.example.test/ " }).origin,
    "https://environment.example.test",
  )
  assert.throws(() => configuredServiceOrigin({}, {}), /OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK=true/)
  assert.equal(configuredServiceOrigin({}, development).origin, DEFAULT_SERVICE_ORIGIN)
  assert.equal(configuredServiceOrigin({}, { ...development, OPENCODE_REMOTE_SERVER_URL: "  " }).origin, DEFAULT_SERVICE_ORIGIN)
  assert.equal(configuredServiceOrigin({ apiUrl: "http://localhost:8081" }, development).origin, "http://localhost:8081")
})

test("explicit invalid apiUrl fails closed instead of using the environment", () => {
  for (const apiUrl of [null, false, 8080, {}, [], "", "  ", "invalid", "http://remote.example.test",
    "https://user:secret@remote.example.test", "https://remote.example.test/v1",
    "https://remote.example.test?token=secret", "https://remote.example.test#fragment", "file:///tmp/api"]) {
    assert.throws(() => configuredServiceOrigin({ apiUrl }, { OPENCODE_REMOTE_SERVER_URL: DEFAULT_SERVICE_ORIGIN }))
  }
})

test("the environment URL still receives the same security validation", () => {
  assert.throws(() => configuredServiceOrigin({}, { OPENCODE_REMOTE_SERVER_URL: "http://remote.example.test" }))
})

test("plaintext API and relay URLs require explicit loopback opt-in, including IPv6", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const apiUrl = `http://${host}:8080`
    const relayUrl = `ws://${host}:8080/v1/relay`
    for (const environment of [{}, { OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK: "false" }]) {
      assert.throws(() => configuredServiceOrigin({ apiUrl }, environment))
      assert.throws(() => validateRelayURL(relayUrl, environment))
      assert.throws(() => validateLocalRelayURL(relayUrl, environment))
    }
    assert.equal(configuredServiceOrigin({ apiUrl }, development).origin, apiUrl)
    assert.equal(validateLocalRelayURL(relayUrl, development).href, relayUrl)
    assert.equal(configuredServiceOrigin({ apiUrl: apiUrl.replace("http:", "https:") }, {}).protocol, "https:")
    assert.equal(validateRelayURL(relayUrl.replace("ws:", "wss:"), {}).protocol, "wss:")
  }
})

test("development opt-in never enables plaintext traffic outside loopback", () => {
  for (const host of ["remote.example.test", "192.168.1.2", "0.0.0.0", "[::]", "localhost.example.test"]) {
    assert.throws(() => configuredServiceOrigin({ apiUrl: `http://${host}` }, development))
    assert.throws(() => validateRelayURL(`ws://${host}/v1/relay`, development))
    assert.throws(() => validateLocalRelayURL(`wss://${host}/dev/relay`, development))
  }
})

test("invalid flags and project options cannot enable insecure transport", () => {
  for (const value of ["1", "yes", "TRUE", "typo"]) {
    const environment = { OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK: value }
    assert.throws(() => configuredServiceOrigin({ apiUrl: "https://remote.example.test" }, environment), /must be true or false/)
    assert.throws(() => validateRelayURL("wss://remote.example.test/v1/relay", environment), /must be true or false/)
  }
  assert.throws(() => configuredServiceOrigin({ apiUrl: DEFAULT_SERVICE_ORIGIN, allowInsecureLoopback: true }, {}))
})

test("development relays reject URL credentials, query strings, and fragments", () => {
  for (const value of ["ws://user:secret@localhost/", "ws://localhost/?ticket=secret", "ws://localhost/#fragment", "ws://localhost/?", "ws://localhost/#", "http://localhost/"]) {
    assert.throws(() => validateLocalRelayURL(value, development))
  }
})
