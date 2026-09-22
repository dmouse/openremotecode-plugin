import { realpath } from "node:fs/promises";
import { z } from "zod";
import { chatRequests, chatSummarySchema, type ChatOperation, type ChatStreamTarget } from "@openremotecode/protocol";
import { ChatAccessError, ChatUnsupportedError, type ChatAdapter } from "../chat-adapter.js";
import { AnsweredQuestionMemory } from "../chat/answered-questions.js";
import type { ChatStreamReader } from "../chat-stream.js";
import { CursorStore } from "../chat/cursor.js";
import { WorkspaceRegistry, type Workspace } from "../chat/workspace.js";
import type { V2Client, V2RequestOptions } from "./client.js";
import { v2Events } from "./event-source.js";
import { buildV2Models } from "./models.js";
import { fetchPendingV2Question, replyToV2Question } from "./questions.js";
import { buildV2Snapshot } from "./snapshot.js";

// Events fatal to the whole connection, not just one session -- OpenCode 2's counterpart to v1's
// server.instance.disposed.
const FATAL_EVENT = "location.shutdown";

// The v2 adapter grows one operation at a time. Anything not listed here is not advertised in
// the connector's capabilities and, if a client sends it anyway, fails as unsupported_operation.
const OPERATIONS = ["project.list", "project.open", "chat.list", "chat.create", "chat.get", "chat.snapshot",
  "chat.subtask.snapshot", "chat.models", "chat.prompt", "chat.abort", "chat.permission.reply",
  "chat.question.reply"] as const satisfies readonly ChatOperation[];
type Supported = (typeof OPERATIONS)[number]
// Capabilities that are not operations: what a snapshot may carry when the client opts in.
const CAPABILITIES: readonly string[] = [...OPERATIONS, "chat.permissions", "chat.tools", "chat.shell",
  "chat.questions", "chat.activities", "chat.images"];

const DEADLINE_MS = 10_000;
const PAGE_SIZE = 50;

const session = z.object({
  id: z.string().min(1).max(256),
  title: z.string().optional(),
  parentID: z.string().min(1).max(256).optional(),
  time: z.object({ updated: z.number().int().nonnegative() }),
  location: z.object({ directory: z.string().min(1) }),
});
const page = z.object({
  data: z.array(session).max(PAGE_SIZE),
  cursor: z.object({ next: z.string().max(16_000).nullish() }),
});

export function toV2ChatSummary(value: z.infer<typeof session>) {
  return chatSummarySchema.parse({
    id: value.id,
    title: (value.title ?? "New chat").slice(0, 512),
    updatedAt: value.time.updated,
    ...(value.parentID ? { parentId: value.parentID } : {}),
  });
}

/// Chat operations for OpenCode v2, over the client the TUI plugin context provides. That client
/// addresses the same local instance the TUI is attached to; no listener is opened and no
/// credential is read from disk.
export class OpenCodeV2ChatAdapter implements ChatAdapter, ChatStreamReader {
  readonly capabilities: readonly string[] = CAPABILITIES;
  readonly #client: V2Client;
  readonly #registry: WorkspaceRegistry;
  readonly #cursors = new CursorStore();
  readonly #answeredQuestions = new AnsweredQuestionMemory();

  constructor(client: V2Client, directory: string, additionalDirectories: unknown = []) {
    this.#client = client;
    this.#registry = new WorkspaceRegistry(directory, additionalDirectories);
  }

  async execute(operation: ChatOperation, body: Record<string, unknown>, cancellation?: AbortSignal): Promise<unknown> {
    if (!Object.hasOwn(chatRequests, operation)) throw new ChatUnsupportedError(operation);
    if (!(OPERATIONS as readonly string[]).includes(operation)) throw new ChatUnsupportedError(operation);
    return this.#run(operation as Supported, body, cancellation);
  }

  async #run(operation: Supported, body: Record<string, unknown>, cancellation?: AbortSignal): Promise<unknown> {
    if (operation === "project.list") {
      const projects = await this.#registry.listVerified();
      return { version: 1, projects: projects.map((w) => this.#registry.public(w)), pathEntry: true };
    }
    if (operation === "project.open") {
      const workspace = await this.#registry.resolvePath(String(body.path));
      return { version: 1, project: this.#registry.public(workspace) };
    }
    const workspace = await this.#registry.get(body.projectId);
    const options = (): V2RequestOptions => ({ signal: cancellation
      ? AbortSignal.any([cancellation, AbortSignal.timeout(DEADLINE_MS)]) : AbortSignal.timeout(DEADLINE_MS) });
    if (operation === "chat.models") return buildV2Models(this.#client, workspace.path, options().signal);
    if (operation === "chat.list") {
      const cursor = this.#cursors.resolve(body, workspace.id);
      const result = page.parse(await this.#client.session.list({ directory: workspace.path, parentID: null,
        limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, options()));
      // The server filters by directory, but the boundary is enforced here too: a session outside
      // this workspace must never reach the phone because a filter was ignored.
      for (const entry of result.data) await this.#assertInWorkspace(entry, workspace);
      // v2 hands back a `next` cursor even on the last page, so a short page is what ends the list.
      const more = result.data.length >= PAGE_SIZE ? result.cursor.next ?? null : null;
      return { version: 1, chats: result.data.filter((s) => !s.parentID).map(toV2ChatSummary),
        cursor: this.#cursors.issue(more, workspace.id) };
    }
    if (operation === "chat.create") {
      const created = await this.#client.session.create({ location: { directory: workspace.path } }, options());
      const owned = await this.#owned(workspace, session.pick({ id: true }).parse(created).id);
      return { version: 1, chat: toV2ChatSummary(owned) };
    }

    const sessionId = String(body.sessionId);
    const owned = await this.#owned(workspace, sessionId);
    if (operation === "chat.subtask.snapshot") {
      const parentSessionId = String(body.parentSessionId);
      // A subtask is reachable only through its own claimed parent, never as an independent chat.
      if (owned.parentID !== parentSessionId) throw new ChatAccessError("access_denied");
      const snapshot = chatRequests["chat.subtask.snapshot"].parse(body);
      const signal = AbortSignal.timeout(DEADLINE_MS);
      return buildV2Snapshot({ client: this.#client, cursors: this.#cursors, workspace, chat: toV2ChatSummary(owned),
        sessionId, body: snapshot, signal, operation, answeredQuestions: this.#answeredQuestions.get(sessionId),
        recheck: async () => {
          await this.#registry.get(workspace.id);
          if ((await this.#owned(workspace, sessionId)).parentID !== parentSessionId) throw new ChatAccessError("access_denied");
        } });
    }
    // Subtask sessions are reachable only through their parent's snapshot, never directly.
    if (owned.parentID) throw new ChatAccessError("access_denied");

    if (operation === "chat.get") return { version: 1, chat: toV2ChatSummary(owned) };
    if (operation === "chat.snapshot") {
      const snapshot = chatRequests["chat.snapshot"].parse(body);
      const signal = AbortSignal.timeout(DEADLINE_MS);
      return buildV2Snapshot({ client: this.#client, cursors: this.#cursors, workspace, chat: toV2ChatSummary(owned),
        sessionId, body: snapshot, signal, operation, answeredQuestions: this.#answeredQuestions.get(sessionId), recheck: async () => {
          await this.#registry.get(workspace.id);
          if ((await this.#owned(workspace, sessionId)).parentID) throw new ChatAccessError("access_denied");
        } });
    }
    if (operation === "chat.abort") {
      await this.#client.session.interrupt({ sessionID: sessionId }, options());
      return { version: 1, accepted: true };
    }
    if (operation === "chat.question.reply") {
      const reply = chatRequests["chat.question.reply"].parse(body);
      const pending = await fetchPendingV2Question(this.#client, sessionId, options().signal);
      // Resolving against the question the connector itself just observed is what keeps
      // client-supplied answers from reaching the agent unverified. See ADR 0011 (v1) / 0013 (v2).
      if (pending?.id !== reply.questionId) throw new ChatAccessError("context_expired");
      const { result, recorded } = await replyToV2Question(this.#client, sessionId, pending, reply, options().signal);
      this.#answeredQuestions.record(sessionId, recorded);
      return result;
    }
    if (operation === "chat.prompt") {
      const prompt = chatRequests["chat.prompt"].parse(body);
      // Neither is advertised, so neither may be silently dropped: a prompt that ran in the wrong
      // mode or on the wrong model is worse than one that is refused.
      if (prompt.mode !== undefined) throw new ChatUnsupportedError("chat.prompt.mode");
      if (prompt.model !== undefined) throw new ChatUnsupportedError("chat.prompt.model");
      await this.#client.session.prompt({ sessionID: sessionId, text: prompt.text }, options());
      return { version: 1, accepted: true };
    }
    // operation === "chat.permission.reply"
    const reply = chatRequests["chat.permission.reply"].parse(body);
    // Passed through unchanged so an explicit "always" is never downgraded.
    await this.#client.permission.reply({ sessionID: sessionId, requestID: reply.permissionId, decision: reply.response }, options());
    return { version: 1, accepted: true };
  }

  /// Verifies membership once, then re-reads the current snapshot on every event for the target
  /// session. v2's client already yields structured events (no raw SSE re-parse needed, unlike
  /// v1's opencode-events.ts); every reconciling read still goes through chat.snapshot, so no
  /// per-part live overlay is required for this first streaming milestone.
  async watchChat(target: ChatStreamTarget, signal: AbortSignal, changed: (reset: boolean) => void): Promise<void> {
    if (target.parentSessionId) throw new ChatUnsupportedError("chat.stream.subscribe.subtasks");
    const workspace = await this.#registry.get(target.projectId);
    const owned = await this.#owned(workspace, target.sessionId);
    if (owned.parentID) throw new ChatAccessError("access_denied");
    signal.throwIfAborted();
    for await (const event of v2Events(this.#client, signal)) {
      if (signal.aborted) return;
      // Unblocks the caller's initial read; mirrors v1's handling of the same marker.
      if (event.type === "server.connected") { changed(false); continue; }
      if (event.type === FATAL_EVENT) throw new Error("Chat source disposed");
      if (event.data?.sessionID !== target.sessionId) continue;
      changed(false);
    }
    if (!signal.aborted) throw new Error("Chat event stream ended");
  }

  async readChat(target: ChatStreamTarget, signal: AbortSignal): Promise<unknown> {
    const { projectId, sessionId, includePermissions } = target;
    return this.execute("chat.snapshot", { version: 1, projectId, sessionId, ...(includePermissions ? { includePermissions } : {}) },
      signal);
  }

  async #owned(workspace: Workspace, sessionId: string): Promise<z.infer<typeof session>> {
    let raw: unknown;
    try {
      raw = await this.#client.session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(DEADLINE_MS) });
    } catch (error) {
      // v2 rejects with a plain tagged object, not an Error: { _tag: "SessionNotFoundError", ... }.
      if (typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "SessionNotFoundError") {
        throw new ChatAccessError("chat_not_found");
      }
      throw error;
    }
    const found = session.parse(raw);
    // Session-by-ID lookups are not scoped to a directory, so membership is checked here.
    if (found.id !== sessionId) throw new ChatAccessError("access_denied");
    await this.#assertInWorkspace(found, workspace);
    return found;
  }

  async #assertInWorkspace(entry: z.infer<typeof session>, workspace: Workspace): Promise<void> {
    const directory = await realpath(entry.location.directory).catch(() => { throw new ChatAccessError("access_denied"); });
    if (directory !== workspace.path) throw new ChatAccessError("access_denied");
  }
}
