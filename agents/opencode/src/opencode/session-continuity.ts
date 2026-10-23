import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ChatAccessError } from "../chat/access-error.js";
import type { Workspace } from "../chat/workspace.js";

interface SessionLocation { id: string; parentID?: string | undefined; location: { directory: string } }
interface Binding { workspace: Workspace; directory: string; dirty: boolean }
const MAX_BINDINGS = 2048;

/// A directory authorizes initial discovery; subsequent access follows the identity of an
/// already authorized root chat. This grants that chat only, never its destination directory.
/// All locations still come from session.get, not a phone or an event payload.
export class SessionContinuity {
  readonly #bindings = new Map<string, Map<string, Binding>>();
  #size = 0;

  knows(sessionId: string, workspace: Workspace): boolean {
    return this.#bindings.get(workspace.id)?.has(sessionId) ?? false;
  }

  ensureRoom(): void {
    if (this.#size >= MAX_BINDINGS) throw new ChatAccessError("context_expired");
  }

  remember(entry: SessionLocation, workspace: Workspace): void {
    if (entry.parentID) return;
    let sessions = this.#bindings.get(workspace.id);
    if (!sessions?.has(entry.id)) this.ensureRoom();
    if (!sessions) { sessions = new Map(); this.#bindings.set(workspace.id, sessions); }
    if (!sessions.has(entry.id)) this.#size++;
    sessions.set(entry.id, { workspace, directory: entry.location.directory, dirty: false });
  }

  moved(sessionId?: string): void {
    for (const sessions of this.#bindings.values()) {
      if (sessionId) {
        const binding = sessions.get(sessionId);
        if (binding) binding.dirty = true;
      } else for (const binding of sessions.values()) binding.dirty = true;
    }
  }

  candidates(workspace: Workspace): string[] {
    return [...this.#bindings.get(workspace.id) ?? []]
      .filter(([, binding]) => binding.dirty || binding.workspace.path !== workspace.path)
      .map(([id]) => id);
  }

  forget(sessionId: string): void {
    for (const [id, sessions] of this.#bindings) {
      if (sessions.delete(sessionId)) this.#size--;
      if (sessions.size === 0) this.#bindings.delete(id);
    }
  }

  async authorize(entry: SessionLocation, workspace: Workspace, locallyOpen = false): Promise<Workspace> {
    const binding = this.#bindings.get(workspace.id)?.get(entry.id);
    const directory = entry.location.directory;
    // eslint-disable-next-line no-control-regex -- locations are hostile even when supplied by OpenCode
    if (!path.isAbsolute(directory) || directory.length > 4096 || /[\x00-\x1f]/u.test(directory)) {
      throw new ChatAccessError("access_denied");
    }
    const canonical = await realpath(directory).catch(() => { throw new ChatAccessError("access_denied"); });
    // Retargeting a symlink is not an OpenCode session move.
    if (binding?.directory === directory && binding.workspace.path !== canonical) throw new ChatAccessError("access_denied");
    if (canonical !== workspace.path && (entry.parentID || (!binding && !locallyOpen))) {
      throw new ChatAccessError("access_denied");
    }
    const info = await stat(canonical).catch(() => { throw new ChatAccessError("access_denied"); });
    if (!info.isDirectory()) throw new ChatAccessError("access_denied");
    const pinned = binding?.workspace.path === canonical ? binding.workspace
      : canonical === workspace.path ? workspace : undefined;
    if (pinned && (info.dev !== pinned.dev || info.ino !== pinned.ino)) throw new ChatAccessError("access_denied");
    const current = { ...workspace, path: canonical, dev: info.dev, ino: info.ino };
    this.remember(entry, current);
    return current;
  }
}
