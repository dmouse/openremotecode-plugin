import type { PluginInput } from "@opencode-ai/plugin";
import type { Part, ToolPart } from "@opencode-ai/sdk";
import type { ChatSubtask } from "@openremotecode/protocol";
import { subtaskSummary } from "../chat-message.js";
import { subtaskStats } from "../chat-subtask.js";
import { ChatAccessError } from "./access-error.js";
import { unwrapResult } from "./sdk-result.js";
import { getChildSession } from "./session-access.js";
import type { Workspace, WorkspaceRegistry } from "./workspace.js";

type Client = PluginInput["client"]

export async function resolveSubtasks(client: Client, registry: WorkspaceRegistry, workspace: Workspace,
    parentId: string, parts: Part[], statuses: Record<string, { type: string }>,
    signal: AbortSignal): Promise<Map<string, ChatSubtask>> {
  const tasks = parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === "task");
  const result = new Map<string, ChatSubtask>();
  // A single snapshot has one deadline and at most eight child reads. No
  // recursive enrichment, unbounded history walk, cache, or background polling.
  for (const part of tasks.slice(-8)) {
    const task = subtaskSummary(part);
    const id = part.state.status !== "pending" ? part.state.metadata?.sessionId : undefined;
    if (typeof id !== "string" || !id || id.length > 128) continue;
    try {
      await getChildSession(client, registry, workspace, parentId, id, signal);
      const response = await client.session.messages({ query: { directory: workspace.path, limit: 100 },
        path: { id }, signal });
      const messages = unwrapResult(response);
      if (!Array.isArray(messages) || messages.length > 100 || messages.some((message) =>
        message.info.sessionID !== id || !Array.isArray(message.parts) || message.parts.some((p) => p.sessionID !== id))) {
        throw new ChatAccessError("access_denied");
      }
      const stats = subtaskStats(messages, !response.response.headers.get("x-next-cursor"));
      await getChildSession(client, registry, workspace, parentId, id, signal);
      const status = statuses[id]?.type;
      result.set(part.id, { ...task, sessionId: id,
        status: status === "busy" ? "running" : status === "retry" ? "retry" : task.status,
        stats: task.status === "completed" && status !== "busy" && status !== "retry"
          ? stats : { toolCalls: stats.toolCalls, complete: stats.complete } });
    } catch {
      // Deleted/unavailable/foreign children do not discard the parent chat.
      // Unverified IDs, child content and exception details never escape.
      result.set(part.id, { ...task, ...(task.background ? { status: "unknown" } : {}) });
    }
  }
  return result;
}
