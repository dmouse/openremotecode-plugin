import type { PluginInput } from "@opencode-ai/plugin"

import {
  remoteSessionSchema,
  type RemoteSession,
} from "@openremotecode/protocol"

type OpenCodeClient = PluginInput["client"]

export interface SessionReader {
  listSessions(): Promise<RemoteSession[]>
}

export class OpenCodeAdapter implements SessionReader {
  readonly #client: OpenCodeClient

  constructor(client: OpenCodeClient) {
    this.#client = client
  }

  async listSessions(): Promise<RemoteSession[]> {
    const result = await this.#client.session.list()
    if (result.error || !Array.isArray(result.data)) {
      throw new Error("OpenCode session list failed")
    }

    return result.data.filter((session) => !session.parentID).map((session) =>
      remoteSessionSchema.parse({
        id: session.id,
        ...(session.parentID ? { parentId: session.parentID } : {}),
        title: session.title.slice(0, 512),
        createdAt: session.time.created,
        updatedAt: session.time.updated,
      }),
    )
  }
}
