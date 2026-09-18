import { z } from "zod";

import {
  connectorPublicIdentitySchema,
  deserializePublicIdentity,
  type ConnectorIdentity,
} from "../crypto/connector-identity.js";
import { decodeBase64Url, encodeBase64Url } from "./base64url.js";

const encoder = new TextEncoder();
const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const proofSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);

export const identityProofSchema = z
  .object({
    challenge: challengeSchema,
    signature: proofSchema,
  })
  .strict();

export const pairingTranscriptSchema = z
  .object({
    version: z.literal(1),
    serviceId: z.string().min(1).max(128),
    pairingId: z.string().min(20).max(64),
    connectorIdentity: connectorPublicIdentitySchema,
    deviceIdentity: connectorPublicIdentitySchema,
  })
  .strict();

export type IdentityProof = z.infer<typeof identityProofSchema>
export type PairingTranscript = z.infer<typeof pairingTranscriptSchema>

export async function signIdentityChallenge(
  identity: ConnectorIdentity,
  challenge: string,
): Promise<IdentityProof> {
  const parsedChallenge = challengeSchema.parse(challenge);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.proofPrivateKey,
    arrayBuffer(identityProofMessage(identity.publicIdentity, parsedChallenge)),
  );
  return identityProofSchema.parse({
    challenge: parsedChallenge,
    signature: encodeBase64Url(signature),
  });
}

export async function verifyIdentityProof(
  identity: unknown,
  proof: unknown,
): Promise<boolean> {
  const parsedProof = identityProofSchema.parse(proof);
  const parsedIdentity = await deserializePublicIdentity(identity);
  const verificationKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(decodeBase64Url(parsedIdentity.identity.publicKey)).buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verificationKey,
    Uint8Array.from(decodeBase64Url(parsedProof.signature)).buffer,
    arrayBuffer(identityProofMessage(parsedIdentity.identity, parsedProof.challenge)),
  );
}

export async function derivePairingSafetyCode(
  transcript: PairingTranscript,
): Promise<string> {
  const parsed = pairingTranscriptSchema.parse(transcript);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", arrayBuffer(pairingTranscriptMessage(parsed))),
  );
  const hexadecimal = Array.from(digest.slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
  return hexadecimal.match(/.{4}/gu)?.join(" ") ?? hexadecimal;
}

function identityProofMessage(
  identity: z.infer<typeof connectorPublicIdentitySchema>,
  challenge: string,
): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "opencode-remote/identity-proof/v1",
      challenge,
      identity.version,
      identity.suite,
      identity.keyId,
      identity.publicKey,
    ]),
  );
}

function pairingTranscriptMessage(transcript: PairingTranscript): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      "opencode-remote/pairing-safety/v1",
      transcript.version,
      transcript.serviceId,
      transcript.pairingId,
      identityTuple(transcript.connectorIdentity),
      identityTuple(transcript.deviceIdentity),
    ]),
  );
}

function identityTuple(
  identity: z.infer<typeof connectorPublicIdentitySchema>,
): readonly [number, string, string, string] {
  return [identity.version, identity.suite, identity.keyId, identity.publicKey];
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
