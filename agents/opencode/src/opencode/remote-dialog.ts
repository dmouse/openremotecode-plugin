import { FileConnectorAuthorizationStore, resolveConnectorAuthorizationPath, type ConnectorAuthorization } from "../auth/authorization-store.js";
import { FileConnectorPairingStore, resolveConnectorPairingPath } from "../auth/pairing-store.js";
import { FileRevocationQueueStore, resolveRevocationQueuePath } from "../auth/revocation-queue.js";
import {
  errorMessage,
  formatDate,
  formatTokenExpiration,
  notifyServiceRevocation,
  readRemoteStatus,
  regeneratePairingCode,
  revokeLocalAccess,
  shortIdentifier,
  type RemoteAccessStores,
  type RemoteStatus,
} from "../remote-access.js";
import { RemoteAPIClient } from "../remote-api-client.js";
import { validateServiceOrigin } from "../service-origin.js";
import { tokenAge } from "../token-age.js";
import type { DialogUI } from "./setup.js";

type RemoteAction = "details" | "regenerate" | "refresh" | "close" | "status" | "service" | "connector"
  | "expires" | "linked" | "back" | "revoke"

// One bounded lookup for a legacy authorization's linking date. Dialogs resolve once and cannot
// be updated in place, so the lookup happens before the details open and simply degrades to "Date unavailable".
const LINKED_LOOKUP_MS = 5_000;

export function remoteAccessStores(): RemoteAccessStores {
  return {
    authorizationStore: new FileConnectorAuthorizationStore(resolveConnectorAuthorizationPath()),
    pairingStore: new FileConnectorPairingStore(resolveConnectorPairingPath()),
    revocationQueueStore: new FileRevocationQueueStore(resolveRevocationQueuePath()),
  };
}

/**
 * The `/remote` dialog. It shows pairing and token state and carries the local
 * kill switch -- the one control that must not depend on the relay, the service, or the phone.
 * The decisions it makes are the ones in remote-access.ts; only the presentation lives here.
 */
export async function openRemoteDialog(ui: DialogUI, stores: RemoteAccessStores, signal: AbortSignal): Promise<void> {
  let status = await currentStatus(stores);
  for (;;) {
    if (signal.aborted) return;
    const action = await ui.dialog.select<RemoteAction>({ title: "Open Remote Code", options: optionsFor(status) });
    if (action === undefined || action === "close") return;
    if (action === "refresh" || action === "status") {
      status = await currentStatus(stores);
      continue;
    }
    if (action === "regenerate" && status.type === "pairing") {
      const confirmed = await ui.dialog.confirm({
        title: "Generate a new pairing code?",
        message: `The current code ${status.pairing.userCode} will stop working.`,
      });
      if (confirmed !== true) continue;
      try {
        status = await regeneratePairingCode(stores, status.pairing, signal, wait);
      } catch (error) {
        status = { type: "error", message: errorMessage(error) };
      }
      continue;
    }
    if (action === "details" && status.type === "connected") {
      const revoked = await showTokenDetails(ui, stores, status.authorization, signal);
      status = revoked ? { type: "revoked" } : await currentStatus(stores);
    }
  }
}

async function currentStatus(stores: RemoteAccessStores): Promise<RemoteStatus> {
  try {
    return await readRemoteStatus(stores.authorizationStore, stores.pairingStore);
  } catch (error) {
    return { type: "error", message: errorMessage(error) };
  }
}

function optionsFor(status: RemoteStatus): { title: string; value: RemoteAction; description?: string; footer?: string }[] {
  if (status.type === "connected") {
    return [
      { title: "Active token", value: "details", description: `Connector ${shortIdentifier(status.authorization.connectorId)}; press Enter for details`, footer: "✓ Active" },
      { title: "Refresh", value: "refresh" },
      { title: "Close", value: "close" },
    ];
  }
  if (status.type === "pairing") {
    return [
      { title: `Pairing code  ${status.pairing.userCode}`, value: "status",
        description: `Enter in the mobile app's Add connection screen; expires ${formatDate(status.pairing.expiresAt)}` },
      { title: "Generate a new pairing code", value: "regenerate" },
      { title: "Refresh", value: "refresh" },
      { title: "Close", value: "close" },
    ];
  }
  if (status.type === "error") {
    return [
      { title: "Pairing status unavailable", value: "status", description: status.message },
      { title: "Refresh", value: "refresh" },
      { title: "Close", value: "close" },
    ];
  }
  if (status.type === "revoked") {
    return [
      { title: "Remote access revoked", value: "status", description: "Restart OpenCode to create a new pairing code." },
      { title: "Close", value: "close" },
    ];
  }
  return [
    { title: "Waiting for the connector", value: "status",
      description: "A pairing code appears once the connector starts. After revoking access, restart OpenCode to pair again." },
    { title: "Refresh", value: "refresh" },
    { title: "Close", value: "close" },
  ];
}

/// Returns true once remote access has actually been revoked, so the caller stops offering it.
async function showTokenDetails(ui: DialogUI, stores: RemoteAccessStores, authorization: ConnectorAuthorization,
    signal: AbortSignal): Promise<boolean> {
  const linkedAt = authorization.linkedAt ?? await lookupLinkedAt(authorization, signal);
  for (;;) {
    if (signal.aborted) return false;
    const action = await ui.dialog.select<RemoteAction>({
      title: "Active token details",
      options: [
        { title: "Token", value: "status", description: "paired", footer: "✓ Active" },
        { title: "Service", value: "service", footer: authorization.serviceOrigin },
        { title: "Connector", value: "connector", footer: authorization.connectorId },
        { title: "Linked", value: "linked", ...(linkedAt ? { description: tokenAge(linkedAt) } : {}),
          footer: linkedAt ? formatTokenExpiration(linkedAt) : "Date unavailable" },
        { title: "Expires", value: "expires", footer: formatTokenExpiration(authorization.credentialExpiresAt) },
        { title: "Back", value: "back", description: "Return to Open Remote Code" },
        { title: "Revoke remote access", value: "revoke", description: "Disconnect this connector" },
      ],
    });
    if (action === undefined || action === "back") return false;
    if (action !== "revoke") continue;
    const confirmed = await ui.dialog.confirm({
      title: "Revoke remote access?",
      message: "Disconnect the linked connector and revoke its remote access. Your local chats remain available. Restart OpenCode to pair again.",
    });
    if (confirmed !== true) continue;
    return revoke(ui, stores, authorization, signal);
  }
}

async function revoke(ui: DialogUI, stores: RemoteAccessStores, authorization: ConnectorAuthorization,
    signal: AbortSignal): Promise<boolean> {
  let serviceOrigin: URL;
  try {
    serviceOrigin = await revokeLocalAccess(stores, authorization);
  } catch {
    // Local authorization is retained on any failure; say so rather than implying it is gone.
    await ui.dialog.alert({ title: "Open Remote Code",
      message: "Revocation could not be completed. Refresh and retry; local authorization has been retained." });
    return false;
  }
  await ui.dialog.alert({ title: "Remote access revoked",
    message: "This connector is disconnected and its local authorization removed. Restart OpenCode to create a new pairing code." });
  // Best effort, and deliberately after the local disable has already taken effect.
  await notifyServiceRevocation(stores, serviceOrigin, authorization.credential, signal);
  return true;
}

async function lookupLinkedAt(authorization: ConnectorAuthorization, signal: AbortSignal): Promise<string | undefined> {
  try {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(LINKED_LOOKUP_MS)]);
    const metadata = await new RemoteAPIClient(validateServiceOrigin(authorization.serviceOrigin))
      .ownConnector(authorization.credential, deadline);
    // Display-only metadata: a mismatch is shown as unknown rather than trusted or written back.
    return metadata.connectorId === authorization.connectorId ? metadata.linkedAt : undefined;
  } catch {
    return undefined;
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("aborted")); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error("aborted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
