import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { ChatSubtask } from "@openremotecode/protocol";
import { subtaskSummary } from "../chat-message.js";
import { subtaskStats } from "../chat-subtask.js";
import { ChatAccessError } from "../chat/access-error.js";
import type { Workspace } from "../chat/workspace.js";
import { convertMessage } from "../message-history.js";
import type { Part, ToolPart } from "../message-parts.js";
import type { OpenCodeClient } from "./client.js";

const MAX_SUBTASKS = 8;
const MAX_MESSAGES = 100;
// Same allowlist buildSnapshot filters chat history by: only user/assistant messages are
// chat content, everything else (bookkeeping, or a kind this build has never seen) is skipped.
const CHAT_TYPES = new Set(["user", "assistant"]);

const childSession = z.object({ id: z.string().min(1), parentID: z.string().optional(),
  location: z.object({ directory: z.string().min(1) }) }).loose();
const messagePage = z.object({ data: z.array(z.object({ type: z.string() }).loose()).max(MAX_MESSAGES),
  cursor: z.object({ next: z.string().max(16_000).nullish() }).loose() });

async function getChildSession(client: OpenCodeClient, workspace: Workspace, parentId: string, id: string,
    signal: AbortSignal): Promise<z.infer<typeof childSession>> {
  let raw: unknown;
  try {
    raw = await client.session.get({ sessionID: id }, { signal });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "SessionNotFoundError") {
      throw new ChatAccessError("access_denied");
    }
    throw error;
  }
  const found = childSession.parse(raw);
  if (found.id !== id || found.parentID !== parentId) throw new ChatAccessError("access_denied");
  const directory = await realpath(found.location.directory).catch(() => { throw new ChatAccessError("access_denied"); });
  if (directory !== workspace.path) throw new ChatAccessError("access_denied");
  return found;
}

/// Resolves child-session "task" tool calls against the message API. Everything that reads a
/// completed subtask's own content goes through the shared presentation functions
/// (subtaskSummary, subtaskStats), which operate on the normalized Part/message shape
/// convertMessage produces for every other tool. The child's id is read from
/// `state.metadata.sessionId`, which the converter preserves verbatim (see ADR 0013). Not exercised against a real model-driven subagent call in this environment.
export async function resolveSubtasks(client: OpenCodeClient, workspace: Workspace, parentId: string, parts: Part[],
    running: Record<string, { type: string } | undefined>, signal: AbortSignal): Promise<Map<string, ChatSubtask>> {
  const tasks = parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === "task");
  const result = new Map<string, ChatSubtask>();
  // One deadline for the whole snapshot, at most eight child reads -- no recursive enrichment,
  // unbounded history walk, cache, or background polling. See ADR 0006.
  for (const part of tasks.slice(-MAX_SUBTASKS)) {
    const task = subtaskSummary(part);
    const id = part.state.status !== "pending" ? part.state.metadata?.sessionId : undefined;
    if (typeof id !== "string" || !id || id.length > 128) continue;
    try {
      await getChildSession(client, workspace, parentId, id, signal);
      const page = messagePage.parse(await client.message.list({ sessionID: id, limit: MAX_MESSAGES, order: "asc" }, { signal }));
      const converted = page.data.filter((m) => CHAT_TYPES.has(m.type)).map((m) => convertMessage(m, id));
      if (converted.some((m) => m.info.sessionID !== id)) throw new ChatAccessError("access_denied");
      // OpenCode returns a next cursor even on the last page (see buildSnapshot); a page shorter than
      // requested is what actually means "nothing more", the same rule used everywhere else here.
      const complete = page.data.length < MAX_MESSAGES;
      const stats = subtaskStats(converted, complete);
      const status = running[id]?.type;
      await getChildSession(client, workspace, parentId, id, signal);
      result.set(part.id, { ...task, sessionId: id,
        // A parent tool can remain "running" in stored history even after
        // its child stops. Only the child's current active entry proves it is
        // still running; otherwise leave an unfinished task unknown until
        // OpenCode records a terminal tool state.
        status: status === "running" ? "running"
          : task.status === "running" ? "unknown" : task.status,
        stats: task.status === "completed" && status !== "running" ? stats : { toolCalls: stats.toolCalls, complete: stats.complete } });
    } catch {
      // Deleted/unavailable/foreign children do not discard the parent chat. Unverified ids,
      // child content and exception details never escape.
      result.set(part.id, { ...task, ...(task.background ? { status: "unknown" } : {}) });
    }
  }
  return result;
}
