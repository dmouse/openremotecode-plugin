import type { PluginInput } from "@opencode-ai/plugin";
import type { PermissionRequest } from "../chat-message.js";
import { unwrapResult } from "./sdk-result.js";
import type { Workspace, WorkspaceRegistry } from "./workspace.js";

type Client = PluginInput["client"]

// Bounds one session's pending list, matching the live capture limit.
export const MAX_PENDING_PERMISSIONS = 64;

// OpenCode 1.18.31 lists every pending permission request across all sessions at
// GET /permission, in creation order. Events alone are not enough: the event stream
// is torn down and rebuilt whenever a client's subscription restarts (every snapshot
// read after a reply does), and OpenCode never replays a pending request to a new
// listener, so a request still waiting at that moment was never shown and its tool
// stayed blocked. Reading the list closes that gap the same way fetchPendingQuestion
// does. The route is a constant here, borrowed through a GET-based SDK method; no
// part of it is chosen by the remote client. A transient failure, or a build without
// the route, yields "nothing pending" rather than a leaked native error -- the
// event-captured value is still used.
export async function fetchPendingPermissions(client: Client, registry: WorkspaceRegistry, workspace: Workspace,
    sessionId: string, signal: AbortSignal): Promise<PermissionRequest[]> {
  try {
    const options = { ...registry.options(workspace), signal, url: "/permission" };
    const list = unwrapResult(await client.session.list(options)) as unknown;
    if (!Array.isArray(list)) return [];
    return (list as ({ sessionID?: unknown; id?: unknown; permission?: unknown } | null | undefined)[])
      .filter((entry): entry is PermissionRequest => entry?.sessionID === sessionId && typeof entry.id === "string" &&
        typeof entry.permission === "string")
      .slice(0, MAX_PENDING_PERMISSIONS);
  } catch {
    return [];
  }
}
