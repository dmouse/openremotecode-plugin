import { deserializePublicIdentity } from "./connector-identity.js";
import type {
  ConnectorIdentity,
  ConnectorPublicIdentity,
} from "./connector-identity.js";
import { hpkeApplicationInfo, hpkeSuite } from "./hpke-suite.js";
import { decodeBase64Url, encodeBase64Url } from "../protocol/base64url.js";
import {
  decodeRelayPayload,
  encodeRelayPayload,
  encryptedRelayEnvelopeSchema,
  envelopeAdditionalData,
  relayPayloadSchema,
  type EncryptedRelayEnvelope,
  type RelayPayload,
} from "../protocol/envelope.js";
import {
  DEFAULT_ENVELOPE_TTL_MS,
  HPKE_SUITE_ID,
  MAX_ENVELOPE_TTL_MS,
  RELAY_PROTOCOL_VERSION,
} from "../protocol/constants.js";
import { relayEpochSchema } from "../protocol/epoch.js";

interface EncryptRelayPayloadOptions {
  sender: ConnectorIdentity
  recipient: ConnectorPublicIdentity
  payload: RelayPayload
  epoch: string
  sequence: number
  now?: number
  ttlMs?: number
  messageId?: string
}

interface DecryptRelayEnvelopeOptions {
  recipient: ConnectorIdentity
  sender: ConnectorPublicIdentity
  envelope: unknown
  epoch: string
  now?: number
}

export async function encryptRelayPayload(
  options: EncryptRelayPayloadOptions,
): Promise<EncryptedRelayEnvelope> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_ENVELOPE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_ENVELOPE_TTL_MS) {
    throw new Error("Envelope TTL is outside the allowed range");
  }

  const { identity: recipient, publicKey: recipientPublicKey } =
    await deserializePublicIdentity(options.recipient);
  const payload = relayPayloadSchema.parse(options.payload);
  const header = {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    type: "relay.envelope",
    messageId: options.messageId ?? crypto.randomUUID(),
    senderKeyId: options.sender.publicIdentity.keyId,
    recipientKeyId: recipient.keyId,
    epoch: relayEpochSchema.parse(options.epoch),
    sequence: options.sequence,
    expiresAt: now + ttlMs,
    suite: HPKE_SUITE_ID,
  } as const;
  const additionalData = envelopeAdditionalData(header);
  const sender = await hpkeSuite.createSenderContext({
    recipientPublicKey,
    senderKey: {
      publicKey: options.sender.publicKey,
      privateKey: options.sender.privateKey,
    },
    info: hpkeApplicationInfo,
  });
  const ciphertext = await sender.seal(
    encodeRelayPayload(payload),
    additionalData,
  );

  return encryptedRelayEnvelopeSchema.parse({
    ...header,
    encapsulatedKey: encodeBase64Url(sender.enc),
    ciphertext: encodeBase64Url(ciphertext),
  });
}

export async function decryptRelayEnvelope(
  options: DecryptRelayEnvelopeOptions,
): Promise<RelayPayload> {
  const envelope = encryptedRelayEnvelopeSchema.parse(options.envelope);
  const now = options.now ?? Date.now();
  if (envelope.epoch !== relayEpochSchema.parse(options.epoch)) {
    throw new Error("Relay envelope belongs to a different connection epoch");
  }
  if (envelope.expiresAt <= now) throw new Error("Relay envelope has expired");
  if (envelope.expiresAt > now + MAX_ENVELOPE_TTL_MS) {
    throw new Error("Relay envelope expiry exceeds the allowed range");
  }
  if (envelope.recipientKeyId !== options.recipient.publicIdentity.keyId) {
    throw new Error("Relay envelope is addressed to a different recipient");
  }

  const { identity: sender, publicKey: senderPublicKey } =
    await deserializePublicIdentity(options.sender);
  if (envelope.senderKeyId !== sender.keyId) {
    throw new Error("Relay envelope sender does not match the trusted identity");
  }

  const recipient = await hpkeSuite.createRecipientContext({
    recipientKey: {
      publicKey: options.recipient.publicKey,
      privateKey: options.recipient.privateKey,
    },
    senderPublicKey,
    enc: decodeBase64Url(envelope.encapsulatedKey),
    info: hpkeApplicationInfo,
  });
  const plaintext = await recipient.open(
    decodeBase64Url(envelope.ciphertext),
    envelopeAdditionalData(envelope),
  );
  return decodeRelayPayload(plaintext);
}
