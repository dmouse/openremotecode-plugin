import type { ChatOperation, RemoteSession } from "@openremotecode/protocol";
import { ChatAccessError, ChatUnsupportedError } from "./chat/access-error.js";

// The interfaces the command dispatcher calls. The OpenCode implementation lives in
// src/opencode/; nothing here names an OpenCode type.

export { ChatAccessError, ChatUnsupportedError };

export interface ChatAdapter {
  /// The capabilities this adapter actually implements. Omitted means the full chat set; an
  /// adapter that supports less must list exactly what it supports so the client fails
  /// explicitly instead of discovering a gap at request time.
  readonly capabilities?: readonly string[]
  execute(operation: ChatOperation, body: Record<string, unknown>): Promise<unknown>
}

/// Serves the connector's `session.list` operation.
export interface SessionReader {
  listSessions(): Promise<RemoteSession[]>
}
