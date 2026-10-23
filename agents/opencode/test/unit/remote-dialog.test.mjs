import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { FileConnectorAuthorizationStore } from "../../dist/auth/authorization-store.js"
import { FileRevocationQueueStore, resolveRevocationQueuePath } from "../../dist/auth/revocation-queue.js"
import { FileConnectorIdentityStore } from "../../dist/crypto/identity-store.js"
import { openRemoteDialog, remoteAccessStores } from "../../dist/opencode/remote-dialog.js"
import { FileFolderApprovalStore } from "../../dist/folder-approvals.js"

const CREDENTIAL = `orc_${"A".repeat(43)}`

// Drives the promise-based dialogs: each `select` answers with the next scripted value, and
// every prompt the dialog showed is recorded so a test can assert on what the user was offered.
function fakeUI(script) {
  const shown = []
  const remaining = [...script]
  // A scripted answer may be a callback, so a test can change the world between two dialog steps
  // the way a real user's timing would.
  const answer = async () => {
    const next = remaining.shift()
    return typeof next === "function" ? next() : next
  }
  return {
    shown,
    ui: {
      dialog: {
        select: (options) => {
          shown.push({ kind: "select", title: options.title, options: options.options })
          return answer()
        },
        confirm: (options) => {
          shown.push({ kind: "confirm", title: options.title, message: options.message })
          return answer()
        },
        alert: (options) => {
          shown.push({ kind: "alert", title: options.title, message: options.message })
          return Promise.resolve()
        },
      },
      toast: { show: () => {} },
    },
  }
}

async function fixture(t, authorization) {
  const directory = await mkdtemp(path.join(tmpdir(), "remote-dialog-"))
  const previous = process.env.OPENCODE_REMOTE_DATA_DIR
  process.env.OPENCODE_REMOTE_DATA_DIR = directory
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENCODE_REMOTE_DATA_DIR
    else process.env.OPENCODE_REMOTE_DATA_DIR = previous
    await rm(directory, { recursive: true, force: true })
  })
  const identity = await new FileConnectorIdentityStore(path.join(directory, "connector-identity.json")).loadOrCreate()
  const paired = (overrides = {}) => ({
    version: 2,
    serviceOrigin: "https://remote.example.test",
    connectorId: "con_0123456789abcdefghijklmn",
    connectorKeyId: identity.publicIdentity.keyId,
    credential: CREDENTIAL,
    credentialExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    trustedClient: identity.publicIdentity,
    linkedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    ...overrides,
  })
  if (authorization) {
    await new FileConnectorAuthorizationStore(path.join(directory, "connector-authorization.json"))
      .replace(paired(authorization === true ? {} : authorization))
  }
  return { directory, stores: remoteAccessStores(), paired }
}

test("a paired connector offers its token, and Close ends the dialog", async (t) => {
  const { stores } = await fixture(t, true)
  const { ui, shown } = fakeUI(["close"])
  await openRemoteDialog(ui, stores, new AbortController().signal)
  assert.equal(shown.length, 1)
  assert.deepEqual(shown[0].options.map((o) => o.value), ["details", "refresh", "close"])
  assert.equal(shown[0].options[0].title, "Active token")
})

test("revoking disables locally before telling the service, and queues the credential for retry", async (t) => {
  const { directory, stores } = await fixture(t, true)
  const { ui, shown } = fakeUI(["details", "revoke", true])
  await openRemoteDialog(ui, stores, new AbortController().signal)

  // The local kill switch ran: authorization, identity and pairing are gone...
  await assert.rejects(access(path.join(directory, "connector-authorization.json")))
  await assert.rejects(access(path.join(directory, "connector-identity.json")))
  // ...and the credential stayed queued, because the service was never reachable in this test.
  const queued = await new FileRevocationQueueStore(resolveRevocationQueuePath()).load()
  assert.equal(queued?.credential, CREDENTIAL)
  assert.equal(queued?.serviceOrigin, "https://remote.example.test")

  const confirm = shown.find((entry) => entry.kind === "confirm")
  assert.match(confirm.title, /Revoke remote access\?/)
  const alert = shown.find((entry) => entry.kind === "alert")
  assert.match(alert.message, /disconnected/i)
})

test("declining the confirmation revokes nothing", async (t) => {
  const { directory, stores } = await fixture(t, true)
  // details -> revoke -> decline -> (details list again) -> back
  const { ui } = fakeUI(["details", "revoke", false, "back", "close"])
  await openRemoteDialog(ui, stores, new AbortController().signal)
  await access(path.join(directory, "connector-authorization.json"))
  const queued = await new FileRevocationQueueStore(resolveRevocationQueuePath()).load()
  assert.equal(queued, undefined)
})

test("a stale dialog cannot revoke a replacement authorization", async (t) => {
  const { directory, stores, paired } = await fixture(t, true)
  const store = new FileConnectorAuthorizationStore(path.join(directory, "connector-authorization.json"))
  // The linked connector changes underneath the dialog, between the confirmation and the revoke.
  const { ui, shown } = fakeUI(["details", "revoke", async () => {
    await store.replace(paired({ credential: `orc_${"B".repeat(43)}` }))
    return true
  }])
  await openRemoteDialog(ui, stores, new AbortController().signal)
  await access(path.join(directory, "connector-authorization.json"))
  const alert = shown.find((entry) => entry.kind === "alert")
  assert.match(alert.message, /could not be completed/i)
})

test("dismissing the dialog with escape closes it instead of acting", async (t) => {
  const { stores } = await fixture(t, true)
  const { ui, shown } = fakeUI([])
  await openRemoteDialog(ui, stores, new AbortController().signal)
  assert.equal(shown.length, 1, "an undefined choice ends the loop rather than repeating it")
})

test("without an authorization the dialog waits for the connector rather than offering a token", async (t) => {
  const { stores } = await fixture(t, undefined)
  const { ui, shown } = fakeUI(["close"])
  await openRemoteDialog(ui, stores, new AbortController().signal)
  assert.deepEqual(shown[0].options.map((o) => o.value), ["status", "refresh", "close"])
  assert.match(shown[0].options[0].title, /Waiting for the connector/)
})

test("an expired credential is not presented as an active token", async (t) => {
  const { stores } = await fixture(t, { credentialExpiresAt: new Date(Date.now() - 1000).toISOString() })
  const { ui, shown } = fakeUI(["close"])
  await openRemoteDialog(ui, stores, new AbortController().signal)
  assert.equal(shown[0].options[0].value, "status")
})

test("/remote offers explicit enable and disable with the full current folder and saved status", async (t) => {
  const { directory, stores } = await fixture(t, true)
  const store = new FileFolderApprovalStore(path.join(directory, "approved-folders"))
  const { ui, shown } = fakeUI(["folder", true, "folder", true, "close"])
  await openRemoteDialog(ui, stores, new AbortController().signal, { directory, store })
  const selections = shown.filter((e) => e.kind === "select")
  assert.equal(selections[0].options[0].title, "Enable remote access for this folder")
  assert.equal(selections[0].options[0].description, directory)
  assert.equal(selections[1].options[0].title, "Disable remote access for this folder")
  assert.equal(selections[1].options[0].footer, "Enabled")
  assert.equal(selections[2].options[0].footer, "Not enabled")
  const confirmations = shown.filter((e) => e.kind === "confirm")
  assert.ok(confirmations.every((e) => e.message.includes(directory)))
  assert.match(confirmations[0].message, /saved until/)
  assert.match(confirmations[1].message, /not deleted/)
  assert.deepEqual(await store.list(), [])
})

test("declining or dismissing a folder confirmation never enables access, even before pairing", async (t) => {
  const { directory, stores } = await fixture(t)
  const store = new FileFolderApprovalStore(path.join(directory, "approved-folders"))
  for (const consent of [false, undefined]) {
    const { ui } = fakeUI(["folder", consent, "close"])
    await openRemoteDialog(ui, stores, new AbortController().signal, { directory, store })
    assert.deepEqual(await store.list(), [])
  }
})

test("aborting a pending folder confirmation does not save approval", async (t) => {
  const { directory, stores } = await fixture(t)
  const store = new FileFolderApprovalStore(path.join(directory, "approved-folders"))
  const controller = new AbortController()
  const { ui } = fakeUI(["folder", () => { controller.abort(); return true }])
  await openRemoteDialog(ui, stores, controller.signal, { directory, store })
  assert.deepEqual(await store.list(), [])
})

test("unavailable folders and write failures never report an approval as enabled", async (t) => {
  const { directory, stores } = await fixture(t)
  const folder = { version: 1, path: directory, dev: 1, ino: 1, enabled: false }
  const { ui, shown } = fakeUI(["folder", true, "close"])
  await openRemoteDialog(ui, stores, new AbortController().signal, { directory, store: {
    inspect: async () => folder, setEnabled: async () => { throw new Error("PRIVATE") },
  } })
  assert.equal(shown.find((e) => e.kind === "alert").title, "Folder access not changed")
  assert.ok(!JSON.stringify(shown).includes("PRIVATE"))
  const unavailable = fakeUI(["folder", "close"])
  await openRemoteDialog(unavailable.ui, stores, new AbortController().signal, { directory, store: {
    inspect: async () => { throw new Error("PRIVATE") }, setEnabled: async () => assert.fail("must not save"),
  } })
  assert.equal(unavailable.shown[0].options[0].title, "Folder access unavailable")
  assert.ok(!unavailable.shown.some((e) => e.kind === "confirm"))
})
