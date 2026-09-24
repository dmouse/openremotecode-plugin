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
  /**
   * Shows the safety code and asks the person at this machine to approve the device that
   * claimed the pairing. Resolves true only on an explicit approval; anything else rejects.
   */
  approveDevice(code: string, expiresAt: string): Promise<boolean>
}

/** Thrown when the person at OpenCode declines the device, so the supervisor can say so. */
export class PairingRejectedError extends Error {
  constructor() {
    super("Pairing was rejected in OpenCode");
    this.name = "PairingRejectedError";
  }
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
    // Approval is asked once per pairing, and the answer is remembered so a failed approve
    // request is retried on the next poll without asking again.
    let approved = false;
    let approvalRecorded = false;
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
        // The server completes a pairing only after this approval, so a person who merely
        // saw or guessed the user code cannot bind this OpenCode to their own account.
        if (state.status === "verification" && !approved) {
          const safetyCode = await derivePairingSafetyCode(state.transcript);
          if (!await this.display.approveDevice(safetyCode, state.expiresAt)) {
            await this.api.cancelPairing(pairing.pairingId, pairing.pairingSecret).catch(() => {});
            await this.pairingStore.clear();
            throw new PairingRejectedError();
          }
          approved = true;
        }
        if (state.status === "verification" && !approvalRecorded) {
          try {
            await this.api.approvePairing(pairing.pairingId, pairing.pairingSecret, trustedClient.keyId);
            approvalRecorded = true;
          } catch (error) {
            if (signal.aborted) throw error;
            // Retried on the next poll; the user's answer is kept.
          }
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
