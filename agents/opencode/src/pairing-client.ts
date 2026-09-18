import {
  derivePairingSafetyCode,
  signIdentityChallenge,
  type ConnectorIdentity,
} from "@openremotecode/protocol";

import type {
  ConnectorAuthorization,
  ConnectorAuthorizationStore,
} from "./auth/authorization-store.js";
import type { ConnectorPairingStore, PendingConnectorPairing } from "./auth/pairing-store.js";
import { type RemoteAPIClient, type PairingPoll } from "./remote-api-client.js";

interface PairingDisplay {
  showPairing(userCode: string, verificationURI: string, expiresAt: string): Promise<void>
  showSafetyCode(code: string, expiresAt: string): Promise<void>
}

export class PairingClient {
  constructor(
    private readonly api: RemoteAPIClient,
    private readonly identity: ConnectorIdentity,
    private readonly store: ConnectorAuthorizationStore,
    private readonly pairingStore: ConnectorPairingStore,
    private readonly display: PairingDisplay,
  ) {}

  async pair(signal: AbortSignal): Promise<ConnectorAuthorization> {
    let pairing = await this.pairingStore.load();
    if (
      pairing?.serviceOrigin !== this.api.serviceOrigin.origin ||
      pairing.connectorKeyId !== this.identity.publicIdentity.keyId ||
      Date.parse(pairing.expiresAt) <= Date.now()
    ) {
      await this.pairingStore.clear();
      const challenge = await this.api.connectorChallenge();
      const proof = await signIdentityChallenge(this.identity, challenge.challenge);
      const started = await this.api.startPairing({
        name: "OpenCode connector",
        identity: this.identity.publicIdentity,
        proof,
      });
      pairing = {
        version: 1,
        serviceOrigin: this.api.serviceOrigin.origin,
        connectorKeyId: this.identity.publicIdentity.keyId,
        ...started,
      } satisfies PendingConnectorPairing;
      await this.pairingStore.replace(pairing);
    }
    await this.display.showPairing(pairing.userCode, pairing.verificationUri, pairing.expiresAt);

    let trustedClient;
    let displayedSafetyCode: string | undefined;
    while (Date.now() < Date.parse(pairing.expiresAt)) {
      await abortableDelay(pairing.pollIntervalSeconds * 1_000, signal);
      let state: PairingPoll;
      try {
        state = await this.api.pollPairing(pairing.pairingId, pairing.pairingSecret);
      } catch (error) {
        if (signal.aborted) throw error;
        continue;
      }
      if (state.pairingId !== pairing.pairingId || state.serviceId !== pairing.serviceId) {
        throw new Error("Pairing response did not match the authorization request");
      }
      if (state.status === "expired") {
        await this.pairingStore.clear();
        throw new Error("Connector pairing expired");
      }
      if (state.transcript) {
        if (
          state.transcript.pairingId !== pairing.pairingId ||
          state.transcript.serviceId !== pairing.serviceId ||
          state.transcript.connectorIdentity.keyId !== this.identity.publicIdentity.keyId ||
          state.transcript.connectorIdentity.publicKey !== this.identity.publicIdentity.publicKey
        ) {
          throw new Error("Pairing transcript replaced the connector identity");
        }
        if (
          trustedClient &&
          (trustedClient.keyId !== state.transcript.deviceIdentity.keyId ||
            trustedClient.publicKey !== state.transcript.deviceIdentity.publicKey)
        ) {
          throw new Error("Pairing transcript changed during verification");
        }
        trustedClient = state.transcript.deviceIdentity;
        const safetyCode = await derivePairingSafetyCode(state.transcript);
        if (displayedSafetyCode !== safetyCode) {
          displayedSafetyCode = safetyCode;
          await this.display.showSafetyCode(safetyCode, state.expiresAt);
        }
      }
      if (state.status !== "completed") continue;
      if (!trustedClient || !state.connectorId || !state.connectorCredential || !state.connectorCredentialExpiresAt) {
        throw new Error("Completed pairing response omitted authorization material");
      }
      const authorization: ConnectorAuthorization = {
        version: 2,
        serviceOrigin: this.api.serviceOrigin.origin,
        connectorId: state.connectorId,
        connectorKeyId: this.identity.publicIdentity.keyId,
        credential: state.connectorCredential,
        credentialExpiresAt: state.connectorCredentialExpiresAt,
        ...(state.linkedAt ? { linkedAt: state.linkedAt } : {}),
        trustedClient,
      };
      await this.store.replace(authorization);
      await this.pairingStore.clear();
      return authorization;
    }
    await this.pairingStore.clear();
    throw new Error("Connector pairing expired");
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  // AbortSignal.reason is typed `any` and isn't guaranteed to be an Error for a custom abort reason.
  const rejectReason = (reject: (reason: Error) => void) => {
    reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
  };
  return new Promise((resolve, reject) => {
    if (signal.aborted) { rejectReason(reject); return; }
    const onAbort = () => {
      clearTimeout(timer);
      rejectReason(reject);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
