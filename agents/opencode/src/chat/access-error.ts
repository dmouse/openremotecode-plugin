export class ChatAccessError extends Error {
  constructor(readonly code: "access_denied" | "context_expired" | "chat_not_found" | "chat_busy") { super(code); }
}
