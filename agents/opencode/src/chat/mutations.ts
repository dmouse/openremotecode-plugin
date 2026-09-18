import type { PluginInput } from "@opencode-ai/plugin";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { ChatAccessError } from "./access-error.js";
import { unwrapResult } from "./sdk-result.js";
import { getSession } from "./session-access.js";
import { toChatSummary } from "./summary.js";
import type { Workspace, WorkspaceRegistry } from "./workspace.js";

type Client = PluginInput["client"]
type Session = NonNullable<Awaited<ReturnType<Client["session"]["get"]>>["data"]>

// Deletes a session and its whole descendant tree. OpenCode deletes descendants too, so the
// complete bounded tree is validated up front to keep the cascade from touching another
// workspace or running work. Returns the deleted session ids so the caller can drop any
// pagination cursors that referenced them.
export async function deleteSession(client: Client, registry: WorkspaceRegistry, workspace: Workspace,
    session: Session | undefined): Promise<Set<string>> {
  if (!session || session.parentID) throw new ChatAccessError("access_denied");
  const options = { query: { directory: workspace.path }, signal: AbortSignal.timeout(10_000) };
  const ids = new Set([session.id]);
  for (const id of ids) {
    options.signal.throwIfAborted();
    const children = unwrapResult(await client.session.children({ ...options, path: { id } }));
    if (!Array.isArray(children) || children.length > 255) throw new ChatAccessError("access_denied");
    for (const child of children) {
      if (child.parentID !== id || ids.has(child.id) || ids.size >= 256 ||
          await realpath(child.directory) !== workspace.path) throw new ChatAccessError("access_denied");
      ids.add(child.id);
    }
  }
  const statuses = unwrapResult(await client.session.status(options));
  if ([...ids].some((id) => statuses[id] && statuses[id].type !== "idle")) throw new ChatAccessError("chat_busy");
  await registry.get(workspace.id);
  if (!unwrapResult(await client.session.delete({ ...options, path: { id: session.id } }))) {
    throw new Error("OpenCode deletion was not confirmed");
  }
  for (const id of ids) {
    const result = await client.session.get({ ...options, path: { id } });
    if (result.response.status !== 404) throw new Error("OpenCode deletion was not confirmed");
  }
  return ids;
}

export async function renameOrForkSession(client: Client, registry: WorkspaceRegistry, workspace: Workspace,
    session: Session, sessionId: string, operation: "chat.rename" | "chat.fork", body: Record<string, unknown>,
    signal: AbortSignal): Promise<{ version: 1; chat: ReturnType<typeof toChatSummary> }> {
  if (session.parentID) throw new ChatAccessError("access_denied");
  const options = { query: { directory: workspace.path }, signal };
  await registry.get(workspace.id);
  if (operation === "chat.fork") {
    // Idle sessions are absent from the pinned SDK's authoritative status map.
    const statuses = z.record(z.string(), z.object({ type: z.enum(["idle", "busy", "retry"]) }))
      .parse(unwrapResult(await client.session.status(options)));
    if (statuses[sessionId] && statuses[sessionId].type !== "idle") throw new ChatAccessError("chat_busy");
    await registry.get(workspace.id);
    if ((await getSession(client, registry, workspace, sessionId, signal)).parentID) throw new ChatAccessError("access_denied");
  }
  signal.throwIfAborted();
  try {
    const result = unwrapResult(operation === "chat.rename"
      ? await client.session.update({ ...options, path: { id: sessionId }, body: { title: String(body.title) } })
      // Omitting messageID copies the full history, not a caller-selected prefix.
      : await client.session.fork({ ...options, path: { id: sessionId }, body: {} }));
    toChatSummary(result);
    if (result.parentID || await realpath(result.directory) !== workspace.path ||
        (operation === "chat.rename" ? result.id !== sessionId || result.title !== body.title : result.id === sessionId)) {
      throw new Error("OpenCode mutation was not confirmed");
    }
    await registry.get(workspace.id);
    const confirmed = await getSession(client, registry, workspace, result.id, signal);
    if (confirmed.parentID || (operation === "chat.rename" && confirmed.title !== body.title)) {
      throw new Error("OpenCode mutation was not confirmed");
    }
    signal.throwIfAborted();
    return { version: 1, chat: toChatSummary(confirmed) };
  } catch {
    // Once dispatched, even failed membership/readback checks are uncertain.
    throw new Error("OpenCode mutation was not confirmed");
  }
}
