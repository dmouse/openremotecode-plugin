import { z } from "zod"

export const SESSION_LIST_OPERATION = "session.list" as const

export const sessionListRequestBodySchema = z.object({}).strict()

export const remoteSessionSchema = z
  .object({
    id: z.string().min(1).max(128),
    parentId: z.string().min(1).max(128).optional(),
    title: z.string().max(512),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()

export const sessionListResponseBodySchema = z
  .object({
    sessions: z.array(remoteSessionSchema).max(10_000),
  })
  .strict()

export const protocolErrorBodySchema = z
  .object({
    code: z.enum([
      "invalid_request",
      "unsupported_operation",
      "opencode_error",
      "access_denied",
      "context_expired",
      "uncertain_outcome",
      "chat_not_found",
      "chat_busy",
    ]),
    message: z.string().min(1).max(256),
  })
  .strict()

export type RemoteSession = z.infer<typeof remoteSessionSchema>
export type SessionListResponseBody = z.infer<
  typeof sessionListResponseBodySchema
>
export type ProtocolErrorBody = z.infer<typeof protocolErrorBodySchema>
