import { z } from "zod"

import { decodeBase64Url, encodeBase64Url } from "../protocol/base64url.js"
import { HPKE_SUITE_ID } from "../protocol/constants.js"
import { hpkeApplicationInfo, hpkeSuite } from "./hpke-suite.js"

const keyIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
const serializedKeySchema = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(1024)

export const connectorPublicIdentitySchema = z
  .object({
    version: z.literal(1),
    suite: z.literal(HPKE_SUITE_ID),
    keyId: keyIdSchema,
    publicKey: serializedKeySchema,
  })
  .strict()

export const serializedConnectorIdentitySchema = connectorPublicIdentitySchema
  .extend({
    privateKey: serializedKeySchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict()

export type ConnectorPublicIdentity = z.infer<
  typeof connectorPublicIdentitySchema
>
export type SerializedConnectorIdentity = z.infer<
  typeof serializedConnectorIdentitySchema
>

export interface ConnectorIdentity {
  publicIdentity: ConnectorPublicIdentity
  publicKey: CryptoKey
  privateKey: CryptoKey
  proofPrivateKey: CryptoKey
}

export async function generateConnectorIdentity(
  createdAt = Date.now(),
): Promise<{
  identity: ConnectorIdentity
  serialized: SerializedConnectorIdentity
}> {
  const keyPair = await hpkeSuite.kem.generateKeyPair()
  const publicKeyBytes = new Uint8Array(
    await hpkeSuite.kem.serializePublicKey(keyPair.publicKey),
  )
  const privateKeyBytes = new Uint8Array(
    await hpkeSuite.kem.serializePrivateKey(keyPair.privateKey),
  )
  const publicKey = encodeBase64Url(publicKeyBytes)
  const publicIdentity = {
    version: 1,
    suite: HPKE_SUITE_ID,
    keyId: await publicKeyId(publicKeyBytes),
    publicKey,
  } as const
  const identity = {
    publicIdentity,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    proofPrivateKey: await importProofPrivateKey(publicKeyBytes, privateKeyBytes),
  }
  await assertKeyPair(identity)

  return {
    identity,
    serialized: {
      ...publicIdentity,
      privateKey: encodeBase64Url(privateKeyBytes),
      createdAt,
    },
  }
}

export async function deserializeConnectorIdentity(
  value: unknown,
): Promise<ConnectorIdentity> {
  const serialized = serializedConnectorIdentitySchema.parse(value)
  const publicKeyBytes = decodeBase64Url(serialized.publicKey)
  const expectedKeyId = await publicKeyId(publicKeyBytes)
  if (serialized.keyId !== expectedKeyId) {
    throw new Error("Connector identity fingerprint does not match its public key")
  }

  const publicKey = await hpkeSuite.kem.deserializePublicKey(publicKeyBytes)
  const privateKey = await hpkeSuite.kem.deserializePrivateKey(
    decodeBase64Url(serialized.privateKey),
  )
  const privateKeyBytes = decodeBase64Url(serialized.privateKey)
  const identity = {
    publicIdentity: {
      version: serialized.version,
      suite: serialized.suite,
      keyId: serialized.keyId,
      publicKey: serialized.publicKey,
    },
    publicKey,
    privateKey,
    proofPrivateKey: await importProofPrivateKey(publicKeyBytes, privateKeyBytes),
  }
  await assertKeyPair(identity)
  return identity
}

export async function generateNonExportableConnectorIdentity(): Promise<ConnectorIdentity> {
  const generated = await hpkeSuite.kem.generateKeyPair()
  const publicKeyBytes = new Uint8Array(
    await hpkeSuite.kem.serializePublicKey(generated.publicKey),
  )
  const privateKeyBytes = new Uint8Array(
    await hpkeSuite.kem.serializePrivateKey(generated.privateKey),
  )
  const publicKey = await hpkeSuite.kem.deserializePublicKey(publicKeyBytes)
  const publicIdentity = {
    version: 1,
    suite: HPKE_SUITE_ID,
    keyId: await publicKeyId(publicKeyBytes),
    publicKey: encodeBase64Url(publicKeyBytes),
  } as const
  const identity = {
    publicIdentity,
    publicKey,
    privateKey: await importEncryptionPrivateKey(publicKeyBytes, privateKeyBytes),
    proofPrivateKey: await importProofPrivateKey(publicKeyBytes, privateKeyBytes),
  }
  privateKeyBytes.fill(0)
  await assertKeyPair(identity)
  return identity
}

export async function restoreConnectorIdentity(value: {
  publicIdentity: ConnectorPublicIdentity
  publicKey: CryptoKey
  privateKey: CryptoKey
  proofPrivateKey: CryptoKey
}): Promise<ConnectorIdentity> {
  const publicIdentity = connectorPublicIdentitySchema.parse(value.publicIdentity)
  const expectedKeyId = await publicKeyId(decodeBase64Url(publicIdentity.publicKey))
  if (publicIdentity.keyId !== expectedKeyId) {
    throw new Error("Connector identity fingerprint does not match its public key")
  }
  assertKey(value.publicKey, "public", "ECDH")
  assertKey(value.privateKey, "private", "ECDH")
  assertKey(value.proofPrivateKey, "private", "ECDSA")
  const storedPublicKey = new Uint8Array(
    await hpkeSuite.kem.serializePublicKey(value.publicKey),
  )
  const expectedPublicKey = decodeBase64Url(publicIdentity.publicKey)
  if (
    storedPublicKey.length !== expectedPublicKey.length ||
    storedPublicKey.some((byte, index) => byte !== expectedPublicKey[index])
  ) {
    throw new Error("Connector identity public key does not match its fingerprint")
  }

  const identity = {
    publicIdentity,
    publicKey: value.publicKey,
    privateKey: value.privateKey,
    proofPrivateKey: value.proofPrivateKey,
  }
  await assertKeyPair(identity)
  return identity
}

export async function deserializePublicIdentity(
  value: unknown,
): Promise<{ identity: ConnectorPublicIdentity; publicKey: CryptoKey }> {
  const identity = connectorPublicIdentitySchema.parse(value)
  const publicKeyBytes = decodeBase64Url(identity.publicKey)
  const expectedKeyId = await publicKeyId(publicKeyBytes)
  if (identity.keyId !== expectedKeyId) {
    throw new Error("Public identity fingerprint does not match its key")
  }

  return {
    identity,
    publicKey: await hpkeSuite.kem.deserializePublicKey(publicKeyBytes),
  }
}

async function publicKeyId(publicKey: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(publicKey)
  return encodeBase64Url(await crypto.subtle.digest("SHA-256", bytes.buffer))
}

async function assertKeyPair(identity: ConnectorIdentity): Promise<void> {
  const plaintext = new TextEncoder().encode("opencode-remote-key-check")
  const sender = await hpkeSuite.createSenderContext({
    recipientPublicKey: identity.publicKey,
    senderKey: {
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
    },
    info: hpkeApplicationInfo,
  })
  const ciphertext = await sender.seal(plaintext)
  const recipient = await hpkeSuite.createRecipientContext({
    recipientKey: {
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
    },
    senderPublicKey: identity.publicKey,
    enc: sender.enc,
    info: hpkeApplicationInfo,
  })
  const decrypted = new Uint8Array(await recipient.open(ciphertext))

  if (
    decrypted.length !== plaintext.length ||
    decrypted.some((byte, index) => byte !== plaintext[index])
  ) {
    throw new Error("Connector identity private key does not match its public key")
  }

  const proofMessage = new TextEncoder().encode("opencode-remote-proof-key-check")
  const proofSignature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.proofPrivateKey,
    Uint8Array.from(proofMessage).buffer,
  )
  const proofPublicKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(decodeBase64Url(identity.publicIdentity.publicKey)).buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    proofPublicKey,
    proofSignature,
    Uint8Array.from(proofMessage).buffer,
  )) {
    throw new Error("Connector proof key does not match its public key")
  }
}

async function importEncryptionPrivateKey(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    privateJWK(publicKey, privateKey, ["deriveBits"]),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )
}

async function importProofPrivateKey(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    privateJWK(publicKey, privateKey, ["sign"]),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  )
}

function privateJWK(
  publicKey: Uint8Array,
  privateKey: Uint8Array,
  keyOps: string[],
): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4 || privateKey.length !== 32) {
    throw new Error("Identity key material is not a P-256 key pair")
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(publicKey.slice(1, 33)),
    y: encodeBase64Url(publicKey.slice(33, 65)),
    d: encodeBase64Url(privateKey),
    ext: false,
    key_ops: keyOps,
  }
}

function assertKey(key: CryptoKey, type: KeyType, algorithm: "ECDH" | "ECDSA"): void {
  if (
    key.type !== type ||
    key.algorithm.name !== algorithm ||
    !("namedCurve" in key.algorithm) ||
    key.algorithm.namedCurve !== "P-256"
  ) {
    throw new Error(`Connector identity requires a P-256 ${algorithm} ${type} key`)
  }
}
