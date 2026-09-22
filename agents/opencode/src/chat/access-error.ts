export class ChatAccessError extends Error {
  constructor(readonly code: "access_denied" | "context_expired" | "chat_not_found" | "chat_busy") { super(code); }
}

/// The connected OpenCode build cannot perform this operation. Surfaced to the client as the
/// protocol's `unsupported_operation`, never as a generic failure or an uncertain outcome.
export class ChatUnsupportedError extends Error {
  constructor(readonly operation: string) { super("unsupported_operation"); }
}
