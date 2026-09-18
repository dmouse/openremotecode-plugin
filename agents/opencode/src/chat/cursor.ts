import { ChatAccessError } from "./access-error.js";

interface Cursor { native: string; projectId: string; sessionId?: string; expires: number }

// Opaque, expiring pagination handles. Native cursor strings never cross the wire directly;
// this maps them to random ids scoped to the project (and session, where relevant) that
// issued them, so a cursor cannot be replayed against a different project or session.
export class CursorStore {
  readonly #cursors = new Map<string, Cursor>();

  issue(native: string | null, projectId: string, sessionId?: string): string | null {
    const now = Date.now();
    for (const [key, value] of this.#cursors) if (value.expires <= now) this.#cursors.delete(key);
    if (!native) return null;
    for (const [id, cursor] of this.#cursors) {
      if (cursor.native === native && cursor.projectId === projectId && cursor.sessionId === sessionId) {
        cursor.expires = now + 300000;
        return id;
      }
    }
    if (this.#cursors.size >= 256) throw new ChatAccessError("context_expired");
    const id = crypto.randomUUID();
    this.#cursors.set(id, { native, projectId, ...(sessionId ? { sessionId } : {}), expires: now + 300000 });
    return id;
  }

  resolve(body: Record<string, unknown>, projectId: string, sessionId?: string): string | undefined {
    if (!body.cursor) return undefined;
    if (typeof body.cursor !== "string") throw new ChatAccessError("context_expired");
    const cursor = this.#cursors.get(body.cursor);
    if (!cursor || cursor.expires <= Date.now() || cursor.projectId !== projectId || cursor.sessionId !== sessionId) {
      throw new ChatAccessError("context_expired");
    }
    return cursor.native;
  }

  // Drops every cursor pinned to a session that no longer exists, e.g. after a delete cascade.
  forget(sessionIds: ReadonlySet<string>): void {
    for (const [key, cursor] of this.#cursors) if (cursor.sessionId && sessionIds.has(cursor.sessionId)) this.#cursors.delete(key);
  }
}
