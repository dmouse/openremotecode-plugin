import { realpath } from "node:fs/promises";
import { z } from "zod";
import { chatRequests, chatSummarySchema, type ChatOperation, type ChatStreamTarget } from "@openremotecode/protocol";
import { ChatAccessError, ChatUnsupportedError, type ChatAdapter } from "../chat-adapter.js";
import { AnsweredQuestionMemory } from "../chat/answered-questions.js";
import type { ChatStreamReader } from "../chat-stream.js";
import { CursorStore } from "../chat/cursor.js";
import { WorkspaceRegistry, type Workspace } from "../chat/workspace.js";
import type { OpenCodeClient, RequestOptions } from "./client.js";
import { openCodeEvents } from "./event-source.js";
import { buildModels, modelEffortLevels } from "./models.js";
import { fetchPendingQuestion, replyToQuestion } from "./questions.js";
import { buildSnapshot } from "./snapshot.js";

// Events fatal to the whole connection, not just one session.
const FATAL_EVENT = "location.shutdown";

// The adapter grows one operation at a time. Anything not listed here is not advertised in
// the connector's capabilities and, if a client sends it anyway, fails as unsupported_operation.
const OPERATIONS = ["project.list", "project.open", "chat.list", "chat.create", "chat.get", "chat.fork", "chat.delete", "chat.snapshot",
  "chat.subtask.snapshot", "chat.models", "chat.prompt", "chat.abort", "chat.permission.reply",
  "chat.question.reply"] as const satisfies readonly ChatOperation[];
type Supported = (typeof OPERATIONS)[number]
// Capabilities that are not operations: what a snapshot may carry when the client opts in.
const CAPABILITIES: readonly string[] = [...OPERATIONS, "chat.permissions", "chat.tools", "chat.shell",
  "chat.questions", "chat.activities", "chat.images", "chat.prompt.mode", "chat.prompt.model"];

const DEADLINE_MS = 10_000;
const PAGE_SIZE = 50;

// The content opt-ins a subscription may negotiate, forwarded verbatim into every stream
// read. includeTodos is deliberately absent: the snapshot refuses it, and a stream must not fail over
// a flag the connector never advertised.
const STREAM_OPT_INS = ["includeTools", "includeShell", "includeActivities", "includeSubtasks",
  "includeImages", "includePermissions", "includeQuestions"] as const satisfies readonly (keyof ChatStreamTarget)[];

/// OpenCode nests an event's session in different places: some carry it at the top of `data`,
/// others only inside the `part` or `info` they are about. Matching just one of those would drop
/// every message-level event and leave a chat that only refreshes when the session itself
/// changes.
function eventSessionId(event: { data?: Record<string, unknown> }): string | undefined {
  const data = event.data;
  if (!data) return undefined;
  const nested = (value: unknown): string | undefined =>
    typeof value === "object" && value !== null && typeof (value as { sessionID?: unknown }).sessionID === "string"
      ? (value as { sessionID: string }).sessionID : undefined;
  if (typeof data.sessionID === "string") return data.sessionID;
  const info = data.info;
  return nested(data.part) ?? nested(info) ??
    (typeof (info as { id?: unknown } | undefined)?.id === "string" ? (info as { id: string }).id : undefined);
}

const session = z.object({
  id: z.string().min(1).max(256),
  title: z.string().optional(),
  parentID: z.string().min(1).max(256).optional(),
  fork: z.object({ sessionID: z.string().min(1).max(256) }).loose().optional(),
  // The session's current agent and model, when the server reports them. Read only to avoid a
  // redundant switch.
  agent: z.string().max(128).optional(),
  model: z.object({ id: z.string(), providerID: z.string(), variant: z.string().optional() }).loose().optional(),
  time: z.object({ updated: z.number().int().nonnegative() }),
  location: z.object({ directory: z.string().min(1) }),
});
const page = z.object({
  data: z.array(session).max(PAGE_SIZE),
  cursor: z.object({ next: z.string().max(16_000).nullish() }),
});
const active = z.record(z.string(), z.object({ type: z.string() }).loose());

export function toChatSummary(value: z.infer<typeof session>) {
  return chatSummarySchema.parse({
    id: value.id,
    title: (value.title ?? "New chat").slice(0, 512),
    updatedAt: value.time.updated,
    ...(value.parentID ? { parentId: value.parentID } : {}),
  });
}

/// Chat operations for OpenCode, over the client the TUI plugin context provides. That client
/// addresses the same local instance the TUI is attached to; no listener is opened and no
/// credential is read from disk.
export class OpenCodeChatAdapter implements ChatAdapter, ChatStreamReader {
  readonly capabilities: readonly string[] = CAPABILITIES;
  readonly #client: OpenCodeClient;
  readonly #registry: WorkspaceRegistry;
  readonly #cursors = new CursorStore();
  readonly #answeredQuestions = new AnsweredQuestionMemory();

  constructor(client: OpenCodeClient, directory: string, additionalDirectories: unknown = [], registry?: WorkspaceRegistry) {
    this.#client = client;
    this.#registry = registry ?? new WorkspaceRegistry(directory, additionalDirectories);
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
    const deadline = this.#deadline(cancellation);
    const options = (): RequestOptions => ({ signal: deadline });
    if (operation === "chat.models") return buildModels(this.#client, workspace.path, options().signal);
    if (operation === "chat.list") {
      const cursor = this.#cursors.resolve(body, workspace.id);
      const result = page.parse(await this.#client.session.list({ directory: workspace.path, parentID: null,
        limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }, options()));
      // The server filters by directory, but the boundary is enforced here too: a session outside
      // this workspace must never reach the phone because a filter was ignored.
      for (const entry of result.data) await this.#assertInWorkspace(entry, workspace);
      // OpenCode hands back a `next` cursor even on the last page, so a short page is what ends the list.
      const more = result.data.length >= PAGE_SIZE ? result.cursor.next ?? null : null;
      return { version: 1, chats: result.data.filter((s) => !s.parentID).map(toChatSummary),
        cursor: this.#cursors.issue(more, workspace.id) };
    }
    if (operation === "chat.create") {
      const created = await this.#client.session.create({ location: { directory: workspace.path } }, options());
      const owned = await this.#owned(workspace, session.pick({ id: true }).parse(created).id);
      return { version: 1, chat: toChatSummary(owned) };
    }

    const sessionId = String(body.sessionId);
    const owned = await this.#owned(workspace, sessionId, options().signal);
    if (operation === "chat.subtask.snapshot") {
      const parentSessionId = String(body.parentSessionId);
      // A subtask is reachable only through its own claimed parent, never as an independent chat.
      if (owned.parentID !== parentSessionId) throw new ChatAccessError("access_denied");
      const snapshot = chatRequests["chat.subtask.snapshot"].parse(body);
      const signal = this.#deadline(cancellation);
      return buildSnapshot({ client: this.#client, cursors: this.#cursors, workspace, chat: toChatSummary(owned),
        sessionId, body: snapshot, signal, operation, answeredQuestions: this.#answeredQuestions.get(sessionId),
        recheck: async () => {
          await this.#registry.get(workspace.id);
          if ((await this.#owned(workspace, sessionId, signal)).parentID !== parentSessionId) throw new ChatAccessError("access_denied");
        } });
    }
    // Subtask sessions are reachable only through their parent's snapshot, never directly.
    if (owned.parentID) throw new ChatAccessError("access_denied");

    if (operation === "chat.fork" || operation === "chat.delete") {
      const descendants = operation === "chat.delete" ? await this.#deleteTree(workspace, sessionId, deadline) : undefined;
      const tree = descendants ? [...descendants.keys()] : [sessionId];
      const running = active.parse(await this.#client.session.active(options()));
      if (tree.some((id) => running[id])) throw new ChatAccessError("chat_busy");
      for (const id of tree) {
        const checked = await this.#owned(workspace, id, deadline);
        if (descendants && checked.parentID !== descendants.get(id)) throw new ChatAccessError("access_denied");
      }
      await this.#registry.get(workspace.id);
      if (operation === "chat.fork") {
        let result: unknown;
        try {
          result = await this.#client.session.fork({ sessionID: sessionId }, options());
        } catch (error) {
          // An empty session cannot be forked. This is a definitive refusal,
          // not an uncertain mutation requiring the user to hunt for a fork.
          if (typeof error === "object" && error !== null &&
              (error as { _tag?: unknown; kind?: unknown })._tag === "InvalidRequestError" &&
              (error as { kind?: unknown }).kind === "empty_session") {
            throw new ChatAccessError("context_expired");
          }
          throw error;
        }
        try {
          const fork = session.parse(result);
          if (fork.id === sessionId || fork.parentID || fork.fork?.sessionID !== sessionId) {
            throw new Error("Fork identity could not be confirmed");
          }
          await this.#assertInWorkspace(fork, workspace);
          const confirmed = await this.#owned(workspace, fork.id, deadline);
          if (confirmed.parentID || confirmed.fork?.sessionID !== sessionId) {
            throw new Error("Fork identity could not be confirmed");
          }
          await this.#registry.get(workspace.id);
          return { version: 1, chat: toChatSummary(confirmed) };
        } catch {
          // The native mutation may already have happened. Even an authorization
          // failure here must not invite a second fork on the phone.
          throw new Error("Fork could not be confirmed");
        }
      }
      await this.#client.session.remove({ sessionID: sessionId }, options());
      try {
        await this.#registry.get(workspace.id);
        for (const id of tree) {
          try {
            await this.#client.session.get({ sessionID: id }, options());
          } catch (error) {
            if (typeof error === "object" && error !== null &&
                (error as { _tag?: unknown })._tag === "SessionNotFoundError") continue;
            throw error;
          }
          throw new Error("Deleted session is still present");
        }
      } catch {
        throw new Error("Deletion could not be confirmed");
      }
      return { version: 1, deleted: true };
    }

    if (operation === "chat.get") return { version: 1, chat: toChatSummary(owned) };
    if (operation === "chat.snapshot") {
      const snapshot = chatRequests["chat.snapshot"].parse(body);
      const signal = this.#deadline(cancellation);
      return buildSnapshot({ client: this.#client, cursors: this.#cursors, workspace, chat: toChatSummary(owned),
        sessionId, body: snapshot, signal, operation, answeredQuestions: this.#answeredQuestions.get(sessionId), recheck: async () => {
          await this.#registry.get(workspace.id);
          if ((await this.#owned(workspace, sessionId, signal)).parentID) throw new ChatAccessError("access_denied");
        } });
    }
    if (operation === "chat.abort") {
      await this.#client.session.interrupt({ sessionID: sessionId }, options());
      return { version: 1, accepted: true };
    }
    if (operation === "chat.question.reply") {
      const reply = chatRequests["chat.question.reply"].parse(body);
      // A form list that cannot be read is not a question to resolve against: it fails the
      // reply as expired rather than reaching the agent with an unverified answer.
      const pending = await fetchPendingQuestion(this.#client, sessionId, options().signal).catch(() => undefined);
      // Resolving against the question the connector itself just observed is what keeps
      // client-supplied answers from reaching the agent unverified. See ADR 0011 / 0013.
      if (pending?.id !== reply.questionId) throw new ChatAccessError("context_expired");
      const { result, recorded } = await replyToQuestion(this.#client, sessionId, pending, reply, options().signal);
      this.#answeredQuestions.record(sessionId, recorded);
      return result;
    }
    if (operation === "chat.prompt") {
      const prompt = chatRequests["chat.prompt"].parse(body);
      // OpenCode's prompt carries neither an agent nor a model; switching the session's agent or
      // model is the only way to choose one, and each switch persists. That is equivalent here
      // because a client names its mode, and its model once one is picked, on every prompt, so
      // each turn still runs under what it asked for. A prompt that names no model runs on
      // whatever the session last used, which is also what the desktop TUI shows. Skipped when
      // the session already runs that agent or model: OpenCode records every switch in the chat's
      // history, and a client naming them on each prompt would otherwise leave one there per
      // turn. An unreported agent or model always switches -- the safe direction. See ADR 0013.
      const switchAgent = prompt.mode !== undefined && owned.agent !== prompt.mode;
      // The effort is the model's variant; omitting it selects the model's default. An agent
      // switch may apply that agent's own model, so a requested model is then always re-applied.
      const model = prompt.model;
      const switchModel = model !== undefined && (switchAgent || owned.model?.providerID !== model.providerID ||
        owned.model.id !== model.modelID || owned.model.variant !== model.effort);
      // Validated before anything is switched, so a refused model never leaves the agent changed.
      // Re-checked against the current model list rather than trusted from the client, even though
      // the mobile client only offers ids chat.models gave it. A model or effort that is no longer
      // listed means the client's list is stale, and nothing has been sent: context_expired, not
      // an uncertain outcome.
      if (switchModel) {
        const levels = await modelEffortLevels(this.#client, workspace.path, model.providerID, model.modelID, options().signal);
        if (levels === undefined || (model.effort !== undefined && !levels.includes(model.effort))) {
          throw new ChatAccessError("context_expired");
        }
      }
      // Switched first and awaited, so the turn cannot start on the old agent or model.
      if (switchAgent && prompt.mode !== undefined) {
        await this.#client.session.switchAgent({ sessionID: sessionId, agent: prompt.mode }, options());
      }
      if (switchModel) {
        await this.#client.session.switchModel({ sessionID: sessionId, model: { id: model.modelID,
          providerID: model.providerID, ...(model.effort !== undefined ? { variant: model.effort } : {}) } }, options());
      }
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
  /// session. Every reconciling read goes through chat.snapshot, so no per-part live overlay is
  /// required.
  async watchChat(target: ChatStreamTarget, signal: AbortSignal, changed: (reset: boolean) => void): Promise<void> {
    if (target.parentSessionId) throw new ChatUnsupportedError("chat.stream.subscribe.subtasks");
    const workspace = await this.#registry.get(target.projectId);
    const owned = await this.#owned(workspace, target.sessionId, this.#deadline(signal));
    if (owned.parentID) throw new ChatAccessError("access_denied");
    signal.throwIfAborted();
    for await (const event of openCodeEvents(this.#client, signal)) {
      if (signal.aborted) return;
      // Unblocks the caller's initial read.
      if (event.type === "server.connected") { changed(false); continue; }
      if (event.type === FATAL_EVENT) throw new Error("Chat source disposed");
      if (eventSessionId(event) !== target.sessionId) continue;
      changed(false);
    }
    if (!signal.aborted) throw new Error("Chat event stream ended");
  }

  async readChat(target: ChatStreamTarget, signal: AbortSignal): Promise<unknown> {
    const { projectId, sessionId } = target;
    // Every content opt-in the subscription negotiated is forwarded, exactly as a direct
    // chat.snapshot would carry it. A stream read that quietly dropped them would deliver a
    // thinner snapshot than the one the same client just fetched by hand, and the client
    // merges updates over its own history: tools, shell, activities, images and subtasks
    // would disappear as soon as the stream took over, and a pending question -- read as
    // "none" when it was never asked for -- would become unanswerable while streaming.
    // includeTodos is the one exception: the snapshot refuses it outright (see buildSnapshot), and
    // failing the whole stream over a flag the connector never advertised would be worse
    // than serving the rest of the snapshot without it.
    return this.execute("chat.snapshot", { version: 1, projectId, sessionId,
      ...Object.fromEntries(STREAM_OPT_INS.filter((flag) => target[flag] === true).map((flag) => [flag, true])) }, signal);
  }

  /// One request deadline, cancelled with the caller. A read whose caller has gone away
  /// (an expired stream lease, an unsubscribe, a torn-down relay) stops there instead of
  /// holding an SDK call open for the rest of the timeout.
  #deadline(cancellation?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(DEADLINE_MS);
    return cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
  }

  /// Collect every child the native delete will cascade to, without a directory
  /// filter that could hide a foreign child. Bound both the tree and pagination;
  /// a cycle, missing cursor or unverifiable member aborts before mutation.
  async #deleteTree(workspace: Workspace, rootId: string, signal: AbortSignal): Promise<Map<string, string | undefined>> {
    const tree = [rootId];
    const seen = new Set(tree);
    const parents = new Map<string, string | undefined>([[rootId, undefined]]);
    for (const parent of tree) {
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const children = page.parse(await this.#client.session.list({ parentID: parent, limit: PAGE_SIZE,
          ...(cursor ? { cursor } : {}) }, { signal }));
        for (const child of children.data) {
          if (child.parentID !== parent || seen.has(child.id)) throw new ChatAccessError("access_denied");
          await this.#assertInWorkspace(child, workspace);
          if (tree.length >= 256) throw new ChatAccessError("context_expired");
          seen.add(child.id);
          tree.push(child.id);
          parents.set(child.id, parent);
        }
        if (children.data.length < PAGE_SIZE) break;
        const next = children.cursor.next;
        if (!next || cursors.has(next)) throw new ChatAccessError("context_expired");
        cursors.add(next);
        cursor = next;
      }
    }
    return parents;
  }

  async #owned(workspace: Workspace, sessionId: string, signal = AbortSignal.timeout(DEADLINE_MS)): Promise<z.infer<typeof session>> {
    let raw: unknown;
    try {
      raw = await this.#client.session.get({ sessionID: sessionId }, { signal });
    } catch (error) {
      // OpenCode rejects with a plain tagged object, not an Error: { _tag: "SessionNotFoundError", ... }.
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
