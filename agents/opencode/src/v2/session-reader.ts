import { z } from "zod";
import { remoteSessionSchema, type RemoteSession } from "@openremotecode/protocol";
import type { SessionReader } from "../opencode-adapter.js";
import type { V2Client } from "./client.js";

const page = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    parentID: z.string().optional(),
    time: z.object({ created: z.number().int().nonnegative(), updated: z.number().int().nonnegative() }),
  })).max(50),
});

/// The connector's legacy `session.list`, for OpenCode v2: root sessions of the plugin's own
/// directory, newest page only.
export class OpenCodeV2SessionReader implements SessionReader {
  readonly #client: V2Client;
  readonly #directory: string;

  constructor(client: V2Client, directory: string) {
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
