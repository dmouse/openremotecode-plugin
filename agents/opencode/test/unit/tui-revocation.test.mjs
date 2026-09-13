import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"

import { FileConnectorAuthorizationStore } from "../../dist/auth/authorization-store.js"
import { FileConnectorIdentityStore } from "../../dist/crypto/identity-store.js"
import plugin from "../../dist/tui.js"
import { createElement, insert, setProp, testRender } from "@opentui/solid"

async function fixture(t, { legacy = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-remote-revoke-"))
  const previous = process.env.OPENCODE_REMOTE_DATA_DIR
  process.env.OPENCODE_REMOTE_DATA_DIR = directory
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENCODE_REMOTE_DATA_DIR
    else process.env.OPENCODE_REMOTE_DATA_DIR = previous
    await rm(directory, { recursive: true, force: true })
  })
  const identityPath = path.join(directory, "connector-identity.json")
  const identity = await new FileConnectorIdentityStore(identityPath).loadOrCreate()
  const store = new FileConnectorAuthorizationStore(path.join(directory, "connector-authorization.json"))
  const authorization = {
    version: 1, serviceOrigin: "https://paired.example.test",
    connectorId: "con_0123456789abcdefghijklmn", connectorKeyId: identity.publicIdentity.keyId,
    credential: `orc_${"A".repeat(43)}`, credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    trustedClient: identity.publicIdentity,
    ...(!legacy ? { linkedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() } : {}),
  }
  await store.replace(authorization)
  let command, dialog
  const controller = new AbortController()
  const disposers = []
  t.after(() => {
    controller.abort()
    for (const dispose of disposers) dispose()
  })
  await plugin.tui({
    theme: { current: { success: "#a3d977", textMuted: "#888888", text: "#ffffff" } },
    slots: { register() { return "status-chip" } },
    keymap: { registerLayer(layer) { command = layer.commands[0]; return () => {} } },
    lifecycle: { signal: controller.signal, onDispose(callback) { disposers.push(callback) } },
    ui: {
      // Model the native renderer: disabled entries are omitted from its list.
      DialogSelect: (props) => ({ ...props, options: props.options.filter((option) => !option.disabled) }),
      DialogConfirm: (props) => props,
      dialog: { setSize() {}, replace(render) { dialog = render() }, clear() {} },
    },
  })
  await command.run()
  return { store, authorization, identityPath, command, dialog: () => dialog }
}

async function waitForResult(fixture) {
  const deadline = Date.now() + 2000
  while (fixture.dialog().options?.[0]?.title === "Revoking remote access..." && Date.now() < deadline) await delay(10)
  assert.notEqual(fixture.dialog().options?.[0]?.title, "Revoking remote access...")
}

test("/remote revocation requires confirmation and cancellation retains authorization", async (t) => {
  const f = await fixture(t)
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not send a request"))
  assert.equal(f.dialog().options.some((item) => item.value === "revoke"), false)
  f.dialog().onSelect(f.dialog().options.find((item) => item.value === "details"))
  assert.equal(f.dialog().title, "Active token details")
  assert.ok(f.dialog().options.some((item) => item.footer === f.authorization.serviceOrigin))
  assert.ok(f.dialog().options.some((item) => item.footer === f.authorization.connectorId))
  const expiration = f.dialog().options.find((item) => item.value === "expires")
  assert.ok(expiration)
  assert.equal(expiration.footer, new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(f.authorization.credentialExpiresAt)))
  const details = f.dialog()
  f.dialog().onSelect(expiration)
  assert.equal(f.dialog(), details)
  assert.equal(JSON.stringify(f.dialog()).includes(f.authorization.credential), false)
  await f.dialog().onSelect({ value: "back" })
  assert.equal(f.dialog().title, "Open Remote Code")
  assert.equal(f.dialog().options.some((item) => item.value === "revoke"), false)
  f.dialog().onSelect({ value: "details" })
  assert.ok(f.dialog().options.some((item) => item.value === "revoke"))
  f.dialog().onSelect({ value: "revoke" })
  assert.equal(f.dialog().title, "Revoke remote access?")
  f.dialog().onCancel()
  assert.equal(f.dialog().title, "Active token details")
  assert.ok(f.dialog().options.some((item) => item.value === "revoke"))
  assert.deepEqual(await f.store.load(), f.authorization)
})

test("confirmed revocation calls the paired service and removes authorization and the old identity", async (t) => {
  const f = await fixture(t)
  let requests = 0
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests += 1
    assert.equal(url.origin, f.authorization.serviceOrigin)
    assert.equal(url.pathname, "/v1/connectors/self/revoke")
    assert.equal(init.headers.Authorization, `Bearer ${f.authorization.credential}`)
    assert.deepEqual(await f.store.load(), f.authorization)
    return new Response(null, { status: 204 })
  })
  f.dialog().onSelect({ value: "details" })
  f.dialog().onSelect({ value: "revoke" })
  const confirm = f.dialog().onConfirm
  confirm()
  confirm()
  await waitForResult(f)
  assert.equal(requests, 1)
  assert.equal(f.dialog().options[0].title, "Remote access revoked")
  assert.equal(await f.store.load(), undefined)
  await assert.rejects(access(f.identityPath), { code: "ENOENT" })
  assert.equal(JSON.stringify(f.dialog()).includes(f.authorization.credential), false)
})

test("failed revocation retains authorization and displays a safe retry message", async (t) => {
  const f = await fixture(t)
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: f.authorization.credential }), { status: 503 }))
  f.dialog().onSelect({ value: "details" })
  f.dialog().onSelect({ value: "revoke" })
  f.dialog().onConfirm()
  await waitForResult(f)
  assert.match(f.dialog().options[0].description, /Refresh and retry/)
  assert.equal(JSON.stringify(f.dialog()).includes(f.authorization.credential), false)
  assert.deepEqual(await f.store.load(), f.authorization)
  await access(f.identityPath)
})

test("a stale dialog cannot revoke a replacement authorization", async (t) => {
  const f = await fixture(t)
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not send a request"))
  f.dialog().onSelect({ value: "details" })
  f.dialog().onSelect({ value: "revoke" })
  const replacement = { ...f.authorization, credential: `orc_${"B".repeat(43)}` }
  await f.store.replace(replacement)
  f.dialog().onConfirm()
  await waitForResult(f)
  assert.deepEqual(await f.store.load(), replacement)
})

test("details show the saved linking date and age without fetching", async (t) => {
  const f = await fixture(t)
  t.mock.method(globalThis, "fetch", async () => assert.fail("must use the saved timestamp"))
  await f.dialog().onSelect({ value: "details" })
  const linked = f.dialog().options.find((item) => item.value === "linked")
  assert.equal(linked.description, "3 days ago")
  assert.match(linked.footer, new RegExp(String(new Date(f.authorization.linkedAt).getFullYear())))
})

test("legacy authorization fetches its original linking date without rewriting credentials", async (t) => {
  const f = await fixture(t, { legacy: true })
  const linkedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.href, "https://paired.example.test/v1/connectors/self")
    assert.equal(init.headers.Authorization, `Bearer ${f.authorization.credential}`)
    assert.equal(init.redirect, "error")
    return Response.json({ connectorId: f.authorization.connectorId, linkedAt })
  })
  await f.dialog().onSelect({ value: "details" })
  assert.equal(f.dialog().options.find((item) => item.value === "linked").description, "2 hours ago")
  assert.deepEqual(await f.store.load(), f.authorization)
})

test("unavailable or mismatched legacy metadata leaves age unknown", async (t) => {
  const f = await fixture(t, { legacy: true })
  for (const body of [{}, { connectorId: "another-connector", linkedAt: "2026-01-01T00:00:00Z" }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(body))
    await f.command.run()
    await f.dialog().onSelect({ value: "details" })
    const linked = f.dialog().options.find((item) => item.value === "linked")
    assert.equal(linked.footer, "Date unavailable")
    assert.equal(linked.description, undefined)
    assert.ok(f.dialog().options.some((item) => item.value === "revoke"))
  }
})

test("a late metadata response cannot reopen details after Back", async (t) => {
  const f = await fixture(t, { legacy: true })
  let respond
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => { respond = resolve }))
  const pending = f.dialog().onSelect({ value: "details" })
  await f.dialog().onSelect({ value: "back" })
  respond(Response.json({ connectorId: f.authorization.connectorId, linkedAt: "2026-01-01T00:00:00Z" }))
  await pending
  assert.equal(f.dialog().title, "Open Remote Code")
})

test("Active is rendered in the success color even inside selected-row text", {
  skip: typeof Bun === "undefined" ? "OpenTUI 0.4.5 native rendering requires Bun; run with bun test" : false,
}, async (t) => {
  const f = await fixture(t)
  const mainIndicator = f.dialog().options.find((item) => item.value === "details").footer
  await f.dialog().onSelect({ value: "details" })
  const detailIndicator = f.dialog().options.find((item) => item.value === "status").footer
  const rendered = await testRender(() => {
    const text = createElement("text")
    setProp(text, "fg", "#101010")
    setProp(text, "bg", "#82aaff")
    insert(text, [mainIndicator, " / ", detailIndicator])
    return text
  }, { width: 40, height: 3 })
  try {
    await rendered.renderOnce()
    assert.match(rendered.captureCharFrame(), /✓ Active \/ ✓ Active/)
    const active = rendered.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.text.includes("Active"))
    assert.ok(active.length > 0)
    for (const span of active) assert.deepEqual(span.fg.toInts().slice(0, 3), [163, 217, 119])
  } finally { rendered.renderer.destroy() }
})
