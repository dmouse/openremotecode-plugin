import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ChatAccessError } from "./access-error.js";

export interface Workspace { id: string; name: string; path: string; dev: number; ino: number }

/// Project identifiers must survive an OpenCode restart. A random id per plugin load
/// silently invalidated every chat the phone already had open: each request resolved its
/// project against the new ids, found none, and failed as `context_expired`, so the chat
/// reported "This project view expired", streaming never resubscribed and questions could
/// not be answered until the user backed out and reopened the project.
///
/// Derived from the canonical path, which the client already receives in every project
/// summary, so a stable id discloses nothing new. RFC 9562 version 8 is the namespace
/// reserved for exactly this: an identifier derived by an implementation-defined rule.
export async function workspaceId(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(`opencode-remote/workspace-id/v1\0${canonical}`));
  const hex = [...new Uint8Array(digest).subarray(0, 16)]
    .map((byte, index) => (index === 6 ? (byte & 0x0f) | 0x80 : index === 8 ? (byte & 0x3f) | 0x80 : byte))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Owns project-directory resolution and the access-tag integrity checks (absolute path,
// no control characters, realpath/dev/ino re-verification) that every chat operation
// depends on before it is allowed to touch a workspace.
export class WorkspaceRegistry {
  readonly #directories: string[];
  readonly #discover: (() => Promise<string[]>) | undefined;
  // Keyed by canonical path so dev/ino stay pinned from first sight: a directory replaced by a
  // different one is refused by get() rather than silently adopted.
  readonly #known = new Map<string, Promise<Workspace>>();

  /// `discover` yields directories other live instances have announced. They are re-read on every
  /// listing so a folder appears when OpenCode starts there and disappears when it exits.
  constructor(directory: string, additionalDirectories: unknown = [], discover?: () => Promise<string[]>) {
    const additional = z.array(z.string().min(1).max(4096)).max(99).parse(additionalDirectories);
    this.#directories = [...new Set([directory, ...additional])];
    this.#discover = discover;
    // eslint-disable-next-line no-control-regex -- deliberately rejects C0 control characters in paths
    if (this.#directories.some((d) => !path.isAbsolute(d) || /[\x00-\x1f]/u.test(d))) {
      throw new ChatAccessError("access_denied");
    }
  }

  async list(): Promise<Workspace[]> {
    const configured = await Promise.all(this.#directories.map((directory) => this.#resolve(directory)));
    // An announced directory that has since vanished is skipped, not fatal: it belongs to
    // another instance, and it must not take down the project list of this one.
    const announced = (await this.#discover?.().catch(() => [] as string[]) ?? [])
      .filter((directory) => !this.#directories.includes(directory));
    const discovered = (await Promise.all(announced.map((directory) => this.#resolve(directory).catch(() => undefined))))
      .filter((entry): entry is Workspace => entry !== undefined);
    const seen = new Set<string>();
    const all = [...configured, ...discovered].filter((entry) => !seen.has(entry.path) && seen.add(entry.path));
    for (const key of this.#known.keys()) if (!seen.has(key)) this.#known.delete(key);
    return all;
  }

  async #resolve(directory: string): Promise<Workspace> {
    const canonical = await realpath(directory);
    let entry = this.#known.get(canonical);
    if (!entry) {
      entry = (async () => {
        const info = await stat(canonical);
        if (!info.isDirectory()) throw new ChatAccessError("access_denied");
        return { id: await workspaceId(canonical), name: path.basename(canonical) || canonical,
          path: canonical, dev: info.dev, ino: info.ino };
      })();
      this.#known.set(canonical, entry);
      entry.catch(() => this.#known.delete(canonical));
    }
    return entry;
  }

  // Lists every configured project and re-verifies each one still resolves to the same
  // directory. Used by project.list, which must never advertise a project whose access
  // tag has gone stale.
  async listVerified(): Promise<Workspace[]> {
    const projects = await this.list();
    for (const project of projects) await this.get(project.id);
    return projects;
  }

  async get(id: unknown): Promise<Workspace> {
    const workspace = (await this.list()).find((entry) => entry.id === id);
    if (!workspace) throw new ChatAccessError("context_expired");
    const canonical = await realpath(workspace.path);
    const info = await stat(canonical);
    if (canonical !== workspace.path || !info.isDirectory() || info.dev !== workspace.dev || info.ino !== workspace.ino) {
      throw new ChatAccessError("access_denied");
    }
    return workspace;
  }

  async resolvePath(entered: string): Promise<Workspace> {
    // eslint-disable-next-line no-control-regex -- deliberately rejects C0 control characters in paths
    if (!path.isAbsolute(entered) || /[\x00-\x1f]/u.test(entered)) throw new ChatAccessError("access_denied");
    const canonical = await realpath(entered).catch(() => { throw new ChatAccessError("access_denied"); });
    const workspace = (await this.list()).find((w) => w.path === canonical);
    if (!workspace) throw new ChatAccessError("access_denied");
    await this.get(workspace.id);
    return workspace;
  }

  public(workspace: Workspace): { id: string; name: string; path: string } {
    return { id: workspace.id, name: workspace.name, path: workspace.path };
  }

  options(workspace: Workspace): { query: { directory: string }; signal: AbortSignal } {
    return { query: { directory: workspace.path }, signal: AbortSignal.timeout(10_000) };
  }
}
