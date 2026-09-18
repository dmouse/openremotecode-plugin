import { z } from "zod";

import { encodeBase64Url } from "./base64url.js";
import { RELAY_PROTOCOL_VERSION } from "./constants.js";

const EPOCH_DOMAIN = "opencode-remote-relay-epoch";
const NONCE_BYTES = 16;

export const relayNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u);
export const relayEpochSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export interface RelayEpochInput {
  connectorKeyId: string
  connectorNonce: string
  clientKeyId: string
  clientNonce: string
}

export function generateRelayNonce(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/**
 * Both peers contribute fresh randomness, so neither the relay nor a previous
 * connection can force an epoch to repeat and make its envelopes replayable.
 */
export async function deriveRelayEpoch(input: RelayEpochInput): Promise<string> {
  const transcript = new TextEncoder().encode(
    JSON.stringify([
      EPOCH_DOMAIN,
      RELAY_PROTOCOL_VERSION,
      input.connectorKeyId,
      relayNonceSchema.parse(input.connectorNonce),
      input.clientKeyId,
      relayNonceSchema.parse(input.clientNonce),
    ]),
  );
  return encodeBase64Url(await crypto.subtle.digest("SHA-256", transcript));
}
