import type { FileConnectorAuthorizationStore, ConnectorAuthorization } from "./auth/authorization-store.js";
import type { FileConnectorPairingStore, PendingConnectorPairing } from "./auth/pairing-store.js";
import type { FileRevocationQueueStore } from "./auth/revocation-queue.js";
import { FileConnectorIdentityStore, resolveConnectorIdentityPath } from "./crypto/identity-store.js";
import { RemoteAPIClient } from "./remote-api-client.js";
import { validateServiceOrigin } from "./service-origin.js";

/// What the remote dialog shows, independent of how opencode/remote-dialog.ts draws it. Kept
/// apart from the dialog so what it means, least of all about revocation, is testable on its own.
export type RemoteStatus =
  | { type: "connected"; authorization: ConnectorAuthorization }
  | { type: "pairing"; pairing: PendingConnectorPairing }
  | { type: "revoked" }
  | { type: "waiting" }
  | { type: "error"; message: string }

export interface RemoteAccessStores {
  authorizationStore: FileConnectorAuthorizationStore
  pairingStore: FileConnectorPairingStore
  revocationQueueStore: FileRevocationQueueStore
}

export async function readRemoteStatus(
  authorizationStore: FileConnectorAuthorizationStore,
  pairingStore: FileConnectorPairingStore,
): Promise<RemoteStatus> {
  const authorization = await authorizationStore.load();
  if (authorization && Date.parse(authorization.credentialExpiresAt) > Date.now()) {
    return { type: "connected", authorization };
  }
  const pairing = await pairingStore.load();
  if (pairing && Date.parse(pairing.expiresAt) > Date.now()) return { type: "pairing", pairing };
  return { type: "waiting" };
}

/**
 * The local kill switch. Disables this device before anything is told to the server: an
 * unreachable or misbehaving service must never be able to keep a confirmed revoke from taking
 * effect here. The credential is queued first, so a retry can still reach the service after this
 * device has forgotten it.
 *
 * Throws when the stored authorization no longer matches the one the dialog was opened on -- a
 * stale dialog must not revoke a replacement -- and leaves local authorization intact on any
 * failure. Returns the validated service origin for the best-effort call that follows.
 */
export async function revokeLocalAccess(
  stores: RemoteAccessStores,
  authorization: ConnectorAuthorization,
): Promise<URL> {
  const current = await stores.authorizationStore.load();
  if (current?.credential !== authorization.credential || current.serviceOrigin !== authorization.serviceOrigin) {
    throw new Error("The linked connector changed. Refresh and try again.");
  }
  const serviceOrigin = validateServiceOrigin(authorization.serviceOrigin);
  await stores.revocationQueueStore.replace({ version: 1, serviceOrigin: serviceOrigin.origin, credential: authorization.credential });
  await stores.pairingStore.clear();
  await new FileConnectorIdentityStore(resolveConnectorIdentityPath()).clear();
  await stores.authorizationStore.clear();
  return serviceOrigin;
}

/// Best-effort, on top of the local disable above. A failure leaves the credential queued and the
/// next plugin start retries telling the service.
export async function notifyServiceRevocation(
  stores: Pick<RemoteAccessStores, "revocationQueueStore">,
  serviceOrigin: URL,
  credential: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await new RemoteAPIClient(serviceOrigin).revokeConnector(credential, signal);
    await stores.revocationQueueStore.clear();
  } catch { /* Left queued deliberately; see the doc comment. */ }
}

/// Cancels a pending pairing and waits for the connector's supervisor to publish a replacement.
/// Resolves with whatever status is current when one appears or the wait runs out.
export async function regeneratePairingCode(
  stores: Pick<RemoteAccessStores, "authorizationStore" | "pairingStore">,
  pairing: PendingConnectorPairing,
  signal: AbortSignal,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<RemoteStatus> {
  const serviceOrigin = validateServiceOrigin(pairing.serviceOrigin);
  await new RemoteAPIClient(serviceOrigin).cancelPairing(pairing.pairingId, pairing.pairingSecret);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !signal.aborted) {
    await wait(250, signal);
    const status = await readRemoteStatus(stores.authorizationStore, stores.pairingStore);
    if (status.type === "connected" || status.type === "error") return status;
    if (status.type === "pairing" && status.pairing.pairingId !== pairing.pairingId) return status;
  }
  return { type: "waiting" };
}

export function shortIdentifier(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}...` : value;
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function formatTokenExpiration(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(value));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
