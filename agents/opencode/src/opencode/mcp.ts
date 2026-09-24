import { z } from "zod";
import { projectMcpSnapshotSchema, type ProjectMcpSnapshot } from "@openremotecode/protocol";
import { ChatAccessError } from "../chat-adapter.js";
import type { WorkspaceRegistry } from "../chat/workspace.js";
import type { ProjectMcpReader } from "../project-mcp.js";
import type { OpenCodeClient } from "./client.js";

// Parse only the fields we expose. Native error text, integration IDs and MCP
// configuration must never leave the connector.
const nativeServer = z.object({
  name: z.string(),
  status: z.object({ status: z.string() }).loose(),
}).loose();
const nativeList = z.object({
  location: z.object({ directory: z.string() }),
  data: z.array(nativeServer).max(100),
});

export class OpenCodeMcpReader implements ProjectMcpReader {
  readonly #client: OpenCodeClient;
  readonly #registry: WorkspaceRegistry;

  constructor(client: OpenCodeClient, registry: WorkspaceRegistry) {
    this.#client = client;
    this.#registry = registry;
  }

  async readProjectMcp(projectId: string, signal: AbortSignal): Promise<ProjectMcpSnapshot> {
    const workspace = await this.#authorized(projectId);
    signal.throwIfAborted();
    let raw: unknown;
    try {
      // The supplied TUI client already addresses this OpenCode instance. Never
      // reach the local HTTP API directly or read server credentials from disk.
      await this.#client.location.get({ location: { directory: workspace.path } }, { signal });
      raw = await this.#client.mcp.list({ location: { directory: workspace.path } }, { signal });
    } catch (error) {
      // A workspace replaced during the native call is still an authorization
      // failure, even if the call itself failed.
      await this.#authorized(projectId);
      signal.throwIfAborted();
      throw error;
    }
    await this.#authorized(projectId);
    signal.throwIfAborted();
    const response = nativeList.parse(raw);
    if (response.location.directory !== workspace.path) throw new ChatAccessError("access_denied");
    const servers = response.data.map(({ name, status }) => ({ name, status: status.status }));
    // Unknown or pending native states cannot be represented by the five-state
    // v1 wire contract. Fail the whole read as unavailable, not empty-ready or
    // a partially misleading server list; a later poll will pick up completion.
    return projectMcpSnapshotSchema.parse({ version: 1, projectId, state: "ready", servers });
  }

  async #authorized(projectId: string) {
    try {
      return await this.#registry.get(projectId);
    } catch (error) {
      if (error instanceof ChatAccessError) throw error;
      // A configured directory removed or replaced between polls must not turn
      // into a non-authorization SDK failure (which the relay sanitizes as unavailable).
      throw new ChatAccessError("access_denied");
    }
  }
}
