import { z } from "zod"

import { connectorPublicIdentitySchema } from "../crypto/connector-identity.js"
import { RELAY_PROTOCOL_VERSION } from "./constants.js"

export const connectorHelloSchema = z
  .object({
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("connector.hello"),
    pluginVersion: z.string().min(1).max(32),
    identity: connectorPublicIdentitySchema,
    capabilities: z.array(z.string().min(1).max(64)).max(64),
  })
  .strict()

export const clientHelloSchema = z
  .object({
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("client.hello"),
    identity: connectorPublicIdentitySchema,
  })
  .strict()

export const connectorOfflineSchema = z
  .object({
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("connector.offline"),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict()

export const clientOfflineSchema = z
  .object({
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("client.offline"),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict()

export const relayReadySchema = z
  .object({
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    type: z.literal("relay.ready"),
    role: z.enum(["client", "connector"]),
    keyId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  })
  .strict()

export type ConnectorHello = z.infer<typeof connectorHelloSchema>
export type ClientHello = z.infer<typeof clientHelloSchema>
export type ConnectorOffline = z.infer<typeof connectorOfflineSchema>
export type ClientOffline = z.infer<typeof clientOfflineSchema>
export type RelayReady = z.infer<typeof relayReadySchema>
