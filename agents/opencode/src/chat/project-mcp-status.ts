import type { PluginInput } from "@opencode-ai/plugin";
import { projectMcpSnapshotSchema, type ProjectMcpSnapshot } from "@openremotecode/protocol";
import { ChatAccessError } from "./access-error.js";
import { unwrapResult } from "./sdk-result.js";
import type { WorkspaceRegistry } from "./workspace.js";

type Client = PluginInput["client"]

export async function fetchProjectMcpStatus(client: Client, registry: WorkspaceRegistry, projectId: string,
    signal: AbortSignal): Promise<ProjectMcpSnapshot> {
  signal.throwIfAborted();
  const workspace = await registry.get(projectId).catch((error: unknown) => {
    throw error instanceof ChatAccessError ? error : new ChatAccessError("access_denied");
  });
  signal.throwIfAborted();
  let native: unknown;
  try {
    // The pinned root SDK takes query/signal options, unlike the v2 SDK.
    native = unwrapResult(await client.mcp.status({ query: { directory: workspace.path }, signal }));
  } catch {
    native = undefined;
  }
  await registry.get(projectId).catch((error: unknown) => {
    throw error instanceof ChatAccessError ? error : new ChatAccessError("access_denied");
  });
  signal.throwIfAborted();
  const unavailable: ProjectMcpSnapshot = { version: 1, projectId, state: "unavailable", servers: [] };
  if (!native || typeof native !== "object" || Array.isArray(native)) return unavailable;
  const names = Object.keys(native);
  if (names.length > 100) return unavailable;
  // Copy only names and status discriminators. Native errors/config never leave this boundary.
  const servers = names.sort().map((name) => {
    const value: unknown = (native as Record<string, unknown>)[name];
    return { name, status: value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>).status : undefined };
  });
  const result = projectMcpSnapshotSchema.safeParse({ version: 1, projectId, state: "ready", servers });
  return result.success ? result.data : unavailable;
}
