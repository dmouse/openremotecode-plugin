import { z } from "zod"
import { relayPayloadSchema } from "./envelope.js"

export const PROJECT_MCP_VERSION = 1 as const
export const projectMcpServerSchema = z.object({
  // eslint-disable-next-line no-control-regex -- deliberately rejects C0/C1 control and bidi-override characters
  name: z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u),
  status: z.enum(["connected", "disabled", "failed", "needs_auth", "needs_client_registration"]),
}).strict()
const project = { version: z.literal(PROJECT_MCP_VERSION), projectId: z.uuid() }
const subscription = { ...project, subscriptionId: z.uuid() }
const status = {
  state: z.enum(["ready", "unavailable"]),
  servers: z.array(projectMcpServerSchema).max(100)
    .refine((servers) => new Set(servers.map((server) => server.name)).size === servers.length),
}
const available = (value: { state: string; servers: unknown[] }) => value.state === "ready" || value.servers.length === 0
export const projectMcpSnapshotSchema = z.object({ ...project, ...status }).strict().refine(available)
export const projectMcpUpdatedSchema = z.object({ ...subscription,
  revision: z.number().int().nonnegative(), ...status }).strict().refine(available)
export const projectMcpRequests = {
  "project.mcp.snapshot": z.object(project).strict(),
  "project.mcp.subscribe": z.object(subscription).strict(),
  "project.mcp.unsubscribe": z.object(subscription).strict(),
} as const
export const projectMcpResponses = {
  "project.mcp.snapshot": projectMcpSnapshotSchema,
  "project.mcp.subscribe": projectMcpUpdatedSchema,
  "project.mcp.unsubscribe": z.object({ version: z.literal(PROJECT_MCP_VERSION), unsubscribed: z.literal(true) }).strict(),
} as const
export const PROJECT_MCP_CAPABILITIES = [...Object.keys(projectMcpRequests), "project.mcp.updated"]
export const projectMcpUpdatedEventSchema = relayPayloadSchema.extend({
  kind: z.literal("event"), operation: z.literal("project.mcp.updated"), body: projectMcpUpdatedSchema,
}).refine((event) => event.requestId === event.body.subscriptionId)
export type ProjectMcpOperation = keyof typeof projectMcpRequests
export type ProjectMcpSnapshot = z.infer<typeof projectMcpSnapshotSchema>
export type ProjectMcpUpdated = z.infer<typeof projectMcpUpdatedSchema>
