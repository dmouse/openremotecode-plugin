export const RELAY_PROTOCOL_VERSION = 2 as const;

export const HPKE_SUITE_ID =
  "HPKE-Auth-P256-HKDF-SHA256-AES-256-GCM" as const;

export const DEFAULT_ENVELOPE_TTL_MS = 60_000;
export const MAX_ENVELOPE_TTL_MS = 5 * 60_000;
export const MAX_CIPHERTEXT_LENGTH = 1_500_000;
