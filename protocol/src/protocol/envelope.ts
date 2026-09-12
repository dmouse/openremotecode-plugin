import { z } from "zod"

import {
  HPKE_SUITE_ID,
  MAX_CIPHERTEXT_LENGTH,
  RELAY_PROTOCOL_VERSION,
} from "./constants.js"

const keyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u)
const timestampSchema = z.number().int().nonnegative()

export const relayPayloadSchema = z
  .object({
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    kind: z.enum(["request", "response", "event", "ack"]),
    requestId: z.uuid(),
    sentAt: timestampSchema,
    operation: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u),
    body: z.json(),
  })
  .strict()

export const encryptedRelayEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.envelope"),
    messageId: z.uuid(),
    senderKeyId: keyIdSchema,
    recipientKeyId: keyIdSchema,
    sequence: z.number().int().nonnegative(),
    expiresAt: timestampSchema,
    suite: z.literal(HPKE_SUITE_ID),
    encapsulatedKey: base64UrlSchema.max(256),
    ciphertext: base64UrlSchema.max(MAX_CIPHERTEXT_LENGTH),
  })
  .strict()

export type RelayPayload = z.infer<typeof relayPayloadSchema>
export type EncryptedRelayEnvelope = z.infer<
  typeof encryptedRelayEnvelopeSchema
>

export function envelopeAdditionalData(
  envelope: Pick<
    EncryptedRelayEnvelope,
    | "protocolVersion"
    | "type"
    | "messageId"
    | "senderKeyId"
    | "recipientKeyId"
    | "sequence"
    | "expiresAt"
    | "suite"
  >,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      "opencode-remote-relay",
      envelope.protocolVersion,
      envelope.type,
      envelope.messageId,
      envelope.senderKeyId,
      envelope.recipientKeyId,
      envelope.sequence,
      envelope.expiresAt,
      envelope.suite,
    ]),
  )
}

export function encodeRelayPayload(payload: RelayPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(relayPayloadSchema.parse(payload)))
}

export function decodeRelayPayload(bytes: ArrayBufferLike): RelayPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new Error("Decrypted relay payload is not valid JSON")
  }
  return relayPayloadSchema.parse(parsed)
}
