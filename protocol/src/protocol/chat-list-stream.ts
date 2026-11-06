import { z } from "zod";
import { chatSummarySchema } from "./chat.js";

const target = { version: z.literal(1), subscriptionId: z.uuid(),
  projectIds: z.array(z.uuid()).min(1).max(100).refine((ids) => new Set(ids).size === ids.length) };
export const chatListStreamRequests = {
  "chat.list.subscribe": z.object(target).strict(),
  "chat.list.unsubscribe": z.object(target).strict(),
};
export const chatListUpdatedSchema = z.object({ ...target,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), reset: z.boolean(),
  changes: z.array(z.object({ projectId: z.uuid(), chat: chatSummarySchema.refine((chat) => !chat.parentId) }).strict()).max(50),
}).strict().refine((update) => update.changes.every((change) => update.projectIds.includes(change.projectId)));
export const CHAT_LIST_STREAM_CAPABILITIES = [...Object.keys(chatListStreamRequests), "chat.list.updated", "chat.list.closed"];
export type ChatListTarget = z.infer<typeof chatListStreamRequests["chat.list.subscribe"]>
export type ChatListUpdate = z.infer<typeof chatListUpdatedSchema>
