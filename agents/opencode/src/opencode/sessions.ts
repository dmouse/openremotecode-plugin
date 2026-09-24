import { z } from "zod";
import { remoteSessionSchema, type RemoteSession } from "@openremotecode/protocol";
import type { SessionReader } from "../chat-adapter.js";
import type { OpenCodeClient } from "./client.js";

const page = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    parentID: z.string().optional(),
    time: z.object({ created: z.number().int().nonnegative(), updated: z.number().int().nonnegative() }),
  })).max(50),
});

/// The connector's legacy `session.list`: root sessions of the plugin's own
/// directory, newest page only.
export class OpenCodeSessionReader implements SessionReader {
  readonly #client: OpenCodeClient;
  readonly #directory: string;

  constructor(client: OpenCodeClient, directory: string) {
    this.#client = client;
    this.#directory = directory;
  }

  async listSessions(): Promise<RemoteSession[]> {
    const result = page.parse(await this.#client.session.list(
      { directory: this.#directory, parentID: null, limit: 50 }, { signal: AbortSignal.timeout(10_000) }));
    return result.data.filter((session) => !session.parentID).map((session) => remoteSessionSchema.parse({
      id: session.id,
      title: (session.title ?? "New chat").slice(0, 512),
      createdAt: session.time.created,
      updatedAt: session.time.updated,
    }));
  }
}
