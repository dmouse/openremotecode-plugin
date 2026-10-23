import { realpath } from "node:fs/promises";
import { z } from "zod";
import { remoteSessionSchema, type RemoteSession } from "@openremotecode/protocol";
import type { SessionReader } from "../chat-adapter.js";
import type { OpenCodeClient } from "./client.js";
import type { WorkspaceRegistry } from "../chat/workspace.js";
import { ChatAccessError } from "../chat/access-error.js";

const page = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    parentID: z.string().optional(),
    time: z.object({ created: z.number().int().nonnegative(), updated: z.number().int().nonnegative() }),
    location: z.object({ directory: z.string().min(1) }),
  })).max(50),
});

/// The connector's legacy `session.list`: root sessions of the plugin's own
/// directory, newest page only.
export class OpenCodeSessionReader implements SessionReader {
  readonly #client: OpenCodeClient;
  readonly #directory: string;

  constructor(client: OpenCodeClient, directory: string, private readonly registry?: WorkspaceRegistry) {
    this.#client = client;
    this.#directory = directory;
  }

  async listSessions(): Promise<RemoteSession[]> {
    // Legacy reads must obey the same approval gate as the chat protocol.
    const workspace = await this.registry?.resolvePath(this.#directory);
    const result = page.parse(await this.#client.session.list(
      { directory: this.#directory, parentID: null, limit: 50 }, { signal: AbortSignal.timeout(10_000) }));
    if (workspace) {
      for (const session of result.data) {
        const directory = await realpath(session.location.directory).catch(() => undefined);
        if (directory !== workspace.path) throw new ChatAccessError("access_denied");
      }
    }
    if (this.registry) await this.registry.resolvePath(this.#directory);
    return result.data.filter((session) => !session.parentID).map((session) => remoteSessionSchema.parse({
      id: session.id,
      title: (session.title ?? "New chat").slice(0, 512),
      createdAt: session.time.created,
      updatedAt: session.time.updated,
    }));
  }
}
