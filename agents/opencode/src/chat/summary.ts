import { z } from "zod";
import { chatSummarySchema } from "@openremotecode/protocol";

const nativeSummary = z.object({ id: z.string(), title: z.string(), parentID: z.string().optional(),
  time: z.object({ updated: z.number() }) });
export const nativePage = z.object({ data: z.array(nativeSummary.extend({
  location: z.object({ directory: z.string() }),
})).max(50), cursor: z.object({ next: z.string().max(16000).nullable() }) });

export function toChatSummary(value: unknown) {
  const session = nativeSummary.parse(value);
  // Native fork titles can exceed the wire limit after OpenCode adds its suffix.
  return chatSummarySchema.parse({ id: session.id, title: session.title.slice(0, 512),
    updatedAt: session.time.updated, ...(session.parentID ? { parentId: session.parentID } : {}) });
}
