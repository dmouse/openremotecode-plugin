import type { PluginInput } from "@opencode-ai/plugin";
import type { Provider } from "@opencode-ai/sdk";
import { realpath } from "node:fs/promises";
import { ChatAccessError } from "./access-error.js";
import { unwrapResult } from "./sdk-result.js";
import type { Workspace, WorkspaceRegistry } from "./workspace.js";

type Client = PluginInput["client"]

export async function getSession(client: Client, registry: WorkspaceRegistry, workspace: Workspace, sessionId: string,
    signal = AbortSignal.timeout(10_000)) {
  signal.throwIfAborted();
  const response = await client.session.get({ ...registry.options(workspace), signal, path: { id: sessionId } });
  if (response.response.status === 404) throw new ChatAccessError("chat_not_found");
  const result = unwrapResult(response);
  // OpenCode's session-by-ID APIs do not enforce directory membership.
  if (result.id !== sessionId || await realpath(result.directory) !== workspace.path) {
    throw new ChatAccessError("access_denied");
  }
  return result;
}

export async function getChildSession(client: Client, registry: WorkspaceRegistry, workspace: Workspace,
    parentId: string, sessionId: string, signal: AbortSignal) {
  if (parentId === sessionId) throw new ChatAccessError("access_denied");
  await getSession(client, registry, workspace, parentId, signal);
  const child = await getSession(client, registry, workspace, sessionId, signal);
  if (child.parentID !== parentId) throw new ChatAccessError("access_denied");
  return child;
}

export async function getProviders(client: Client, registry: WorkspaceRegistry, workspace: Workspace): Promise<Provider[]> {
  try {
    return unwrapResult(await client.config.providers(registry.options(workspace))).providers;
  } catch {
    // A transient provider-config failure yields an empty list, never a leaked native error.
    return [];
  }
}
