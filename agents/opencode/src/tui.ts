import type {
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"

import {
  FileConnectorAuthorizationStore,
  resolveConnectorAuthorizationPath,
  type ConnectorAuthorization,
} from "./auth/authorization-store.js"
import { FileConnectorIdentityStore, resolveConnectorIdentityPath } from "./crypto/identity-store.js"
import {
  FileConnectorPairingStore,
  resolveConnectorPairingPath,
  type PendingConnectorPairing,
} from "./auth/pairing-store.js"
import { RemoteAPIClient } from "./remote-api-client.js"
import { validateServiceOrigin } from "./service-origin.js"
import { tokenAge } from "./token-age.js"
import { registerRemoteStatusChip } from "./tui-status-indicator.js"

type RemoteStatus =
  | { type: "connected"; authorization: ConnectorAuthorization }
  | { type: "pairing"; pairing: PendingConnectorPairing }
  | { type: "revoked" }
  | { type: "waiting" }
  | { type: "error"; message: string }

type RemoteAction = "regenerate" | "details" | "back" | "revoke" | "refresh" | "close" | "status" | "service" | "connector" | "expires" | "linked"

// eslint-disable-next-line @typescript-eslint/require-await -- TuiPlugin's type requires a Promise<void>-returning function
const tui: TuiPlugin = async (api) => {
  const authorizationStore = new FileConnectorAuthorizationStore(resolveConnectorAuthorizationPath())
  const pairingStore = new FileConnectorPairingStore(resolveConnectorPairingPath())

  // api.keymap's type chain (@opentui/keymap) doesn't fully resolve through
  // this optional peer dependency; tsc accepts it under skipLibCheck.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: "opencode-remote.open",
        title: "Open Remote Code",
        description: "Manage pairing and revoke remote access",
        category: "Remote",
        namespace: "palette",
        slashName: "remote",
        run: () => showRemoteDialog(api, authorizationStore, pairingStore),
      },
    ],
  })
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- see comment above on `unregister`'s origin
  api.lifecycle.onDispose(unregister)

  const stopStatusChip = registerRemoteStatusChip(api)
  api.lifecycle.onDispose(stopStatusChip)
}

async function showRemoteDialog(
  api: TuiPluginApi,
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
): Promise<void> {
  let status: RemoteStatus
  try {
    status = await readRemoteStatus(authorizationStore, pairingStore)
  } catch (error) {
    status = { type: "error", message: errorMessage(error) }
  }
  renderRemoteDialog(api, authorizationStore, pairingStore, status)
}

function renderRemoteDialog(
  api: TuiPluginApi,
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
  status: RemoteStatus,
): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => api.ui.DialogSelect<RemoteAction>({
    title: "Open Remote Code",
    flat: true,
    skipFilter: true,
    options: remoteOptions(api, status),
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the "details" branch below intentionally returns a promise; callers (incl. tests) rely on awaiting it
    onSelect: (option) => {
      if (option.value === "close") {
        api.ui.dialog.clear()
        return
      }
      if (option.value === "refresh") {
        void showRemoteDialog(api, authorizationStore, pairingStore)
        return
      }
      if (option.value === "regenerate" && status.type === "pairing") {
        confirmRegeneration(api, authorizationStore, pairingStore, status.pairing)
      }
      if (option.value === "details" && status.type === "connected") {
        return showTokenDetails(api, authorizationStore, pairingStore, status.authorization)
      }
    },
  }))
}

function remoteOptions(api: TuiPluginApi, status: RemoteStatus): TuiDialogSelectOption<RemoteAction>[] {
  if (status.type === "connected") {
    return [
      {
        title: "Active token",
        value: "details",
        description: `Connector ${shortIdentifier(status.authorization.connectorId)}; press Enter for details`,
        footer: activeIndicator(api),
      },
      { title: "Refresh", value: "refresh" },
      { title: "Close", value: "close" },
    ]
  }
  if (status.type === "pairing") {
    return [
      {
        title: `Pairing code  ${status.pairing.userCode}`,
        value: "status",
        description: `Enter in the mobile app's Add connection screen; expires ${formatDate(status.pairing.expiresAt)}`,
      },
      { title: "Generate a new pairing code", value: "regenerate" },
      { title: "Refresh", value: "refresh" },
      { title: "Close", value: "close" },
    ]
  }
  if (status.type === "error") {
    return [
      { title: "Pairing status unavailable", value: "status", description: status.message },
      { title: "Refresh", value: "refresh" },
      { title: "Close", value: "close" },
    ]
  }
  if (status.type === "revoked") {
    return [
      { title: "Remote access revoked", value: "status", description: "Restart OpenCode to create a new pairing code." },
      { title: "Close", value: "close" },
    ]
  }
  return [
    {
      title: "Waiting for the connector plugin",
      value: "status",
      description: "A pairing code will appear after the server plugin starts. After revoking access, restart OpenCode to pair again.",
    },
    { title: "Refresh", value: "refresh" },
    { title: "Close", value: "close" },
  ]
}

async function showTokenDetails(
  api: TuiPluginApi,
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
  authorization: ConnectorAuthorization,
): Promise<void> {
  if (authorization.linkedAt) {
    renderTokenDetails(api, authorizationStore, pairingStore, authorization)
    return
  }
  const controller = new AbortController()
  const onLeave = () => { controller.abort(); }
  renderTokenDetails(api, authorizationStore, pairingStore, authorization, { loading: true, onLeave })
  let linkedAt: string | undefined
  try {
    const metadata = await new RemoteAPIClient(validateServiceOrigin(authorization.serviceOrigin)).ownConnector(
      authorization.credential, AbortSignal.any([controller.signal, api.lifecycle.signal]),
    )
    if (metadata.connectorId !== authorization.connectorId) throw new Error("Connector metadata mismatch")
    linkedAt = metadata.linkedAt
  } catch { /* Older servers and offline services leave the age unknown. */ }
  if (controller.signal.aborted || api.lifecycle.signal.aborted) return
  const current = await authorizationStore.load().catch(() => undefined)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- either signal can abort during the preceding await
  if (controller.signal.aborted || api.lifecycle.signal.aborted) return
  if (current?.credential !== authorization.credential || current.serviceOrigin !== authorization.serviceOrigin) return
  // Legacy metadata is display-only: a delayed lookup must never rewrite authorization after revocation.
  renderTokenDetails(api, authorizationStore, pairingStore, {
    ...authorization, ...(linkedAt ? { linkedAt } : {}),
  })
}

function renderTokenDetails(
  api: TuiPluginApi,
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
  authorization: ConnectorAuthorization,
  lookup?: { loading: boolean; onLeave: () => void },
): void {
  api.ui.dialog.replace(() => api.ui.DialogSelect<RemoteAction>({
    title: "Active token details",
    flat: true,
    skipFilter: true,
    options: [
      { title: "Token", value: "status", description: "paired", footer: activeIndicator(api) },
      // OpenCode hides disabled options. Keep metadata visible; selecting it is a no-op.
      { title: "Service", value: "service", footer: authorization.serviceOrigin },
      { title: "Connector", value: "connector", footer: authorization.connectorId },
      {
        title: "Linked", value: "linked",
        ...(authorization.linkedAt ? { description: tokenAge(authorization.linkedAt) } : {}),
        footer: authorization.linkedAt ? formatTokenExpiration(authorization.linkedAt) : lookup?.loading ? "Loading…" : "Date unavailable",
      },
      { title: "Expires", value: "expires", footer: formatTokenExpiration(authorization.credentialExpiresAt) },
      { title: "Back", value: "back", description: "Return to Open Remote Code" },
      { title: "Revoke remote access", value: "revoke", description: "Disconnect this connector" },
    ],
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the "back" branch below intentionally returns a promise; callers (incl. tests) rely on awaiting it
    onSelect: (option) => {
      if (option.value === "back") {
        lookup?.onLeave()
        return showRemoteDialog(api, authorizationStore, pairingStore)
      }
      if (option.value !== "revoke") return
      lookup?.onLeave()
      let revoking = false
      api.ui.dialog.replace(() => api.ui.DialogConfirm({
        title: "Revoke remote access?",
        message: "Disconnect the linked connector and revoke its remote access. Your local chats remain available. Restart OpenCode to pair again.",
        onCancel: () => { renderTokenDetails(api, authorizationStore, pairingStore, authorization); },
        onConfirm: () => {
          if (revoking) return
          revoking = true
          void revokeRemoteAccess(api, authorizationStore, pairingStore, authorization)
        },
      }))
    },
  }), lookup?.onLeave)
}

function activeIndicator(api: TuiPluginApi): TuiDialogSelectOption<RemoteAction>["footer"] {
  // A span retains the success color inside the native list's selected-row text.
  const render = () => {
    const span = createElement("span")
    setProp(span, "style", { fg: api.theme.current.success })
    insert(span, "✓ Active")
    return span
  }
  // Solid accepts lazy JSX accessors at runtime; its DOM JSX type omits OpenTUI renderables.
  return render as unknown as TuiDialogSelectOption<RemoteAction>["footer"]
}

async function revokeRemoteAccess(
  api: TuiPluginApi,
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
  authorization: ConnectorAuthorization,
): Promise<void> {
  api.ui.dialog.replace(() => api.ui.DialogSelect<RemoteAction>({
    title: "Open Remote Code",
    flat: true,
    skipFilter: true,
    options: [{ title: "Revoking remote access...", value: "status" }],
  }))
  try {
    const current = await authorizationStore.load()
    if (current?.credential !== authorization.credential || current.serviceOrigin !== authorization.serviceOrigin) {
      throw new Error("The linked connector changed. Refresh and try again.")
    }
    const serviceOrigin = validateServiceOrigin(authorization.serviceOrigin)
    await new RemoteAPIClient(serviceOrigin).revokeConnector(authorization.credential, api.lifecycle.signal)
    const latest = await authorizationStore.load()
    if (latest?.credential !== authorization.credential || latest.serviceOrigin !== authorization.serviceOrigin) {
      throw new Error("The linked connector changed during revocation")
    }
    // Retain the authorization until cleanup finishes so a lost response or filesystem failure can be retried.
    await pairingStore.clear()
    await new FileConnectorIdentityStore(resolveConnectorIdentityPath()).clear()
    await authorizationStore.clear()
    if (!api.lifecycle.signal.aborted) renderRemoteDialog(api, authorizationStore, pairingStore, { type: "revoked" })
  } catch {
    if (api.lifecycle.signal.aborted) return
    renderRemoteDialog(api, authorizationStore, pairingStore, {
      type: "error",
      message: "Revocation could not be completed. Refresh and retry; local authorization has been retained.",
    })
  }
}

function confirmRegeneration(
  api: TuiPluginApi,
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
  pairing: PendingConnectorPairing,
): void {
  api.ui.dialog.replace(() => api.ui.DialogConfirm({
    title: "Generate a new pairing code?",
    message: `The current code ${pairing.userCode} will stop working.`,
    onCancel: () => { renderRemoteDialog(api, authorizationStore, pairingStore, { type: "pairing", pairing }); },
    onConfirm: () => void regeneratePairing(api, authorizationStore, pairingStore, pairing),
  }))
}

async function regeneratePairing(
  api: TuiPluginApi,
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
  pairing: PendingConnectorPairing,
): Promise<void> {
  api.ui.dialog.replace(() => api.ui.DialogSelect<RemoteAction>({
    title: "Open Remote Code",
    flat: true,
    skipFilter: true,
    options: [{ title: "Generating a new pairing code...", value: "status" }],
  }))
  try {
    const serviceOrigin = validateServiceOrigin(pairing.serviceOrigin)
    await new RemoteAPIClient(serviceOrigin).cancelPairing(pairing.pairingId, pairing.pairingSecret)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !api.lifecycle.signal.aborted) {
      await delay(250, api.lifecycle.signal)
      const status = await readRemoteStatus(authorizationStore, pairingStore)
      if (status.type === "connected" || status.type === "error") {
        renderRemoteDialog(api, authorizationStore, pairingStore, status)
        return
      }
      if (status.type === "pairing" && status.pairing.pairingId !== pairing.pairingId) {
        renderRemoteDialog(api, authorizationStore, pairingStore, status)
        return
      }
    }
    renderRemoteDialog(api, authorizationStore, pairingStore, { type: "waiting" })
  } catch (error) {
    if (api.lifecycle.signal.aborted) return
    renderRemoteDialog(api, authorizationStore, pairingStore, {
      type: "error",
      message: errorMessage(error),
    })
  }
}

async function readRemoteStatus(
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
): Promise<RemoteStatus> {
  const authorization = await authorizationStore.load()
  if (authorization && Date.parse(authorization.credentialExpiresAt) > Date.now()) {
    return {
      type: "connected",
      authorization,
    }
  }
  const pairing = await pairingStore.load()
  if (pairing && Date.parse(pairing.expiresAt) > Date.now()) return { type: "pairing", pairing }
  return { type: "waiting" }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  // AbortSignal.reason is typed `any` and isn't guaranteed to be an Error for a custom abort reason.
  const rejectReason = (reject: (reason: Error) => void) => {
    reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) { rejectReason(reject); return }
    const onAbort = () => {
      clearTimeout(timer)
      rejectReason(reject)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function shortIdentifier(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}...` : value
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString()
}

function formatTokenExpiration(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const plugin = { id: "opencode-remote", tui } satisfies TuiPluginModule & { id: string }

export default plugin
