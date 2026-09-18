import { z } from "zod";

import { relayPayloadSchema } from "./envelope.js";

export const CONNECTOR_CREDENTIAL_VERSION = 1 as const;
export const CONNECTOR_CREDENTIAL_UPDATED_OPERATION = "connector.credential.updated";

/**
 * Reports that the connector tried to renew its own credential. The body deliberately
 * carries no credential value, no identifier, and no service error text: the client only
 * needs to know that an attempt happened and how it ended.
 */
export const connectorCredentialUpdatedSchema = z.object({
  version: z.literal(CONNECTOR_CREDENTIAL_VERSION),
  outcome: z.enum(["renewed", "failed"]),
  occurredAt: z.number().int().nonnegative(),
}).strict();

/**
 * The only connector event that is not tied to a subscription, so unlike the others its
 * requestId correlates with nothing and is simply a fresh identifier.
 */
export const connectorCredentialUpdatedEventSchema = relayPayloadSchema.extend({
  kind: z.literal("event"),
  operation: z.literal(CONNECTOR_CREDENTIAL_UPDATED_OPERATION),
  body: connectorCredentialUpdatedSchema,
});

export const CONNECTOR_CREDENTIAL_CAPABILITIES = [CONNECTOR_CREDENTIAL_UPDATED_OPERATION];

export type ConnectorCredentialOutcome = z.infer<typeof connectorCredentialUpdatedSchema>["outcome"]
export type ConnectorCredentialUpdated = z.infer<typeof connectorCredentialUpdatedSchema>
