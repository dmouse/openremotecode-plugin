import type {
  ConnectorAuthorization,
  ConnectorAuthorizationStore,
} from "./authorization-store.js";

/**
 * Renew once the credential is inside the final third of the service's 90-day lifetime.
 * Expressed as remaining time so it needs no issue timestamp and behaves the same for an
 * authorization written before rotation existed.
 */
const RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface CredentialRotationClient {
  rotateConnectorCredential(
    credential: string,
    signal?: AbortSignal,
  ): Promise<{ credential: string; activateBy: string }>
  activateConnectorCredential(
    credential: string,
    signal?: AbortSignal,
  ): Promise<{ credentialExpiresAt: string }>
}

/** What the maintenance pass actually did, so the caller can report it without re-deriving the renewal window. */
export type CredentialMaintenanceOutcome = "unchanged" | "renewed" | "failed"

export interface CredentialMaintenanceResult {
  authorization: ConnectorAuthorization
  outcome: CredentialMaintenanceOutcome
}

interface MaintainOptions {
  store: ConnectorAuthorizationStore
  api: CredentialRotationClient
  authorization: ConnectorAuthorization
  now?: () => number
  signal?: AbortSignal
}

/**
 * Settles any rotation left pending by an earlier run, then renews the credential if it is
 * close enough to expiry. Returns the authorization that is now on disk. It never throws and
 * never leaves the caller without a usable credential: every failure path returns the most
 * recent authorization that was persisted successfully.
 */
export async function maintainConnectorCredential(
  options: MaintainOptions,
): Promise<CredentialMaintenanceResult> {
  const now = options.now ?? Date.now;
  const settled = await settlePending(options, options.authorization, now);
  if (Date.parse(settled.credentialExpiresAt) - now() > RENEWAL_WINDOW_MS) {
    // Settling a rotation left pending by an earlier run still counts as a renewal: it is
    // the moment the new credential actually became the live one.
    const outcome = settled.credential === options.authorization.credential ? "unchanged" : "renewed";
    return { authorization: settled, outcome };
  }
  return rotate(options, settled, now);
}

/**
 * Resolves a credential this plugin recorded but may never have activated. Activation is
 * attempted first, because a rotation committed just before a crash leaves the pending
 * credential as the only working one.
 */
async function settlePending(
  options: MaintainOptions,
  authorization: ConnectorAuthorization,
  now: () => number,
): Promise<ConnectorAuthorization> {
  const pending = authorization.pending;
  if (!pending) return authorization;
  try {
    const { credentialExpiresAt } = await options.api.activateConnectorCredential(
      pending.credential,
      options.signal,
    );
    const promoted = withoutPending({
      ...authorization,
      credential: pending.credential,
      credentialExpiresAt,
    });
    await options.store.replace(promoted);
    return promoted;
  } catch {
    // A failure here is ambiguous — rejected, or never delivered — and the server may still
    // hold this credential as pending. Only its own deadline proves it is worthless.
    if (Date.parse(pending.activateBy) > now()) return authorization;
    const dropped = withoutPending(authorization);
    await options.store.replace(dropped).catch(() => undefined);
    return dropped;
  }
}

async function rotate(
  options: MaintainOptions,
  authorization: ConnectorAuthorization,
  now: () => number,
): Promise<CredentialMaintenanceResult> {
  // Nothing to renew with: an expired credential has to re-pair instead.
  if (Date.parse(authorization.credentialExpiresAt) <= now()) {
    return { authorization, outcome: "unchanged" };
  }
  let persisted = authorization;
  try {
    const issued = await options.api.rotateConnectorCredential(
      authorization.credential,
      options.signal,
    );
    // Durable before activation. Activation retires the previous credential, so a crash
    // between the two must not leave this one unrecorded.
    persisted = {
      ...authorization,
      pending: { credential: issued.credential, activateBy: issued.activateBy },
    };
    await options.store.replace(persisted);
    const { credentialExpiresAt } = await options.api.activateConnectorCredential(
      issued.credential,
      options.signal,
    );
    const promoted = withoutPending({
      ...persisted,
      credential: issued.credential,
      credentialExpiresAt,
    });
    await options.store.replace(promoted);
    return { authorization: promoted, outcome: "renewed" };
  } catch {
    return { authorization: persisted, outcome: "failed" };
  }
}

function withoutPending(authorization: ConnectorAuthorization): ConnectorAuthorization {
  const { pending: _pending, ...rest } = authorization;
  return rest;
}
