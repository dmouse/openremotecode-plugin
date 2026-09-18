import { z } from "zod";
import { chatResponses } from "./chat.js";
const target = { version: z.literal(1), projectId: z.uuid(), sessionId: z.string().min(1).max(128),
  parentSessionId: z.string().min(1).max(128).optional(), subscriptionId: z.uuid() };
export const chatStreamRequests = {
  "chat.stream.subscribe": z.object({ ...target, includeTools: z.boolean().optional(), includeShell: z.boolean().optional(),
    includeActivities: z.boolean().optional(), includeSubtasks: z.boolean().optional(), includeImages: z.boolean().optional(),
    includePermissions: z.boolean().optional(), includeQuestions: z.boolean().optional(),
    includeTodos: z.boolean().optional() }).strict()
    .refine((body) => !body.includeShell || body.includeTools === true),
  "chat.stream.unsubscribe": z.object(target).strict(),
};
export const chatStreamUpdateSchema = z.object({ ...target,
  revision: z.number().int().nonnegative(), reset: z.boolean(),
  resetRevision: z.number().int().nonnegative().optional(),
  snapshot: chatResponses["chat.snapshot"],
}).strict().refine((update) => update.sessionId === update.snapshot.chat.id &&
  update.parentSessionId === update.snapshot.chat.parentId &&
  (update.resetRevision === undefined || update.resetRevision <= update.revision));
export const chatStreamClosedSchema = z.object(target).strict();
export const CHAT_STREAM_CAPABILITIES = [...Object.keys(chatStreamRequests), "chat.stream.updated", "chat.stream.closed"];
export type ChatStreamTarget = z.infer<typeof chatStreamRequests["chat.stream.subscribe"]>
export type ChatStreamUpdate = z.infer<typeof chatStreamUpdateSchema>
