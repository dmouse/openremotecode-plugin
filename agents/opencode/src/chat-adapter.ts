import type { PluginInput } from "@opencode-ai/plugin";
import { realpath } from "node:fs/promises";
import { chatRequests, chatResponses, type ChatOperation, type ProjectMcpSnapshot } from "@openremotecode/protocol";
import type { ChatStreamTarget } from "@openremotecode/protocol";
import { ChatAccessError } from "./chat/access-error.js";
import { AnsweredQuestionMemory } from "./chat/answered-questions.js";
import { CursorStore } from "./chat/cursor.js";
import { fetchProjectMcpStatus } from "./chat/project-mcp-status.js";
import { deleteSession, renameOrForkSession } from "./chat/mutations.js";
import { buildPromptRequestBody, effortLevelsFor } from "./chat/prompt.js";
import { replyToQuestion, resolvePendingQuestion } from "./chat/questions.js";
import { getChildSession, getProviders, getSession } from "./chat/session-access.js";
import { unwrapResult } from "./chat/sdk-result.js";
import { buildChatSnapshot } from "./chat/snapshot.js";
import { nativePage, toChatSummary } from "./chat/summary.js";
import { WorkspaceRegistry } from "./chat/workspace.js";
import type { ProjectMcpReader } from "./project-mcp.js";
import { LiveParts } from "./live-parts.js";
import { openCodeEvents } from "./opencode-events.js";

type Client = PluginInput["client"]

export { ChatAccessError };
export interface ChatAdapter {
  execute(operation: ChatOperation, body: Record<string, unknown>): Promise<unknown>
}

export class OpenCodeChatAdapter implements ChatAdapter, ProjectMcpReader {
  readonly #client: Client;
  readonly #registry: WorkspaceRegistry;
  readonly #cursors = new CursorStore();
  readonly #liveParts = new Map<string, LiveParts>();
  readonly #liveChanged = new Map<string, () => void>();
  readonly #answeredQuestions = new AnsweredQuestionMemory();

  constructor(client: Client, directory: string, additionalDirectories: unknown = []) {
    this.#client = client;
    this.#registry = new WorkspaceRegistry(directory, additionalDirectories);
  }

  async readProjectMcp(projectId: string, signal: AbortSignal): Promise<ProjectMcpSnapshot> {
    return fetchProjectMcpStatus(this.#client, this.#registry, projectId, signal);
  }

  async readChat(target: ChatStreamTarget, signal: AbortSignal, reconcile = false): Promise<unknown> {
    const { subscriptionId, parentSessionId, includeSubtasks, ...body } = target;
    const live = this.#liveParts.get(subscriptionId);
    const workspace = await this.#registry.get(target.projectId);
    const options = { includeTools: target.includeTools === true, includeShell: target.includeShell === true,
      includeActivities: target.includeActivities === true, includePermissions: target.includePermissions === true,
      includeTodos: target.includeTodos === true, directory: workspace.path,
      answeredQuestions: this.#answeredQuestions.get(target.sessionId) };
    if (live?.snapshot && !reconcile && !live.needsSnapshot) {
      // Authenticate each batch, but don't reread all messages or child tools to
      // deliver a text delta already received from the authorized source stream.
      const session = parentSessionId ? await getChildSession(this.#client, this.#registry, workspace, parentSessionId, target.sessionId, signal)
        : await getSession(this.#client, this.#registry, workspace, target.sessionId, signal);
      if (!parentSessionId && session.parentID) throw new ChatAccessError("access_denied");
      await this.#registry.get(target.projectId);
      if (parentSessionId) await getChildSession(this.#client, this.#registry, workspace, parentSessionId, target.sessionId, signal);
      else if ((await getSession(this.#client, this.#registry, workspace, target.sessionId, signal)).parentID) throw new ChatAccessError("access_denied");
      signal.throwIfAborted();
      const result = live.project({ ...live.snapshot, chat: toChatSummary(session) }, options);
      if (live.reconcileSoon) {
        live.reconcileSoon = false;
        live.needsSnapshot = true;
        this.#liveChanged.get(subscriptionId)?.();
      }
      return result;
    }
    const revision = live?.snapshotRevision ?? 0;
    const result = chatResponses["chat.snapshot"].parse(await this.execute(parentSessionId ? "chat.subtask.snapshot" : "chat.snapshot",
      { ...body, ...(parentSessionId ? { parentSessionId } : includeSubtasks !== undefined ? { includeSubtasks } : {}) },
      signal, live));
    live?.remember(result, revision);
    return live ? live.project(result, options) : result;
  }
  async watchChat(target: ChatStreamTarget, signal: AbortSignal, changed: (reset: boolean) => void): Promise<void> {
    const workspace = await this.#registry.get(target.projectId);
    if (target.parentSessionId) await getChildSession(this.#client, this.#registry, workspace, target.parentSessionId, target.sessionId, signal);
    else if ((await getSession(this.#client, this.#registry, workspace, target.sessionId, signal)).parentID) throw new ChatAccessError("access_denied");
    signal.throwIfAborted();
    // Use the supplied local SDK transport and canonical project context. No
    // public OpenCode listener or provider request is introduced.
    const live = new LiveParts(target.sessionId);
    this.#liveParts.set(target.subscriptionId, live);
    this.#liveChanged.set(target.subscriptionId, () => { changed(false); });
    try {
      for await (const raw of openCodeEvents(this.#client, workspace.path, signal)) {
        if (signal.aborted) return;
        // Pinned compatibility boundary: runtime v1/v2 event shapes are normalized
        // here. Event text/metadata never escapes through this invalidation hook.
        const event = raw as { type: string; properties?: { sessionID?: string;
          part?: { sessionID?: string }; info?: { id?: string; sessionID?: string } } };
        const p = event.properties;
        if (event.type === "server.connected") { changed(false); continue; }
        if (event.type === "server.instance.disposed") throw new Error("Chat source disposed");
        const id = p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID ?? p?.info?.id;
        if (id !== target.sessionId) continue;
        live.capture(raw);
        if (event.type.startsWith("message.") || event.type.startsWith("session.") ||
            event.type.startsWith("permission.") || event.type.startsWith("question.") ||
            event.type.startsWith("todo.")) {
          changed(event.type === "message.removed" || event.type === "message.part.removed" || event.type === "session.compacted");
        }
      }
      if (!signal.aborted) throw new Error("Chat event stream ended");
    } finally {
      if (this.#liveParts.get(target.subscriptionId) === live) {
        this.#liveParts.delete(target.subscriptionId);
        this.#liveChanged.delete(target.subscriptionId);
      }
      live.clear();
    }
  }
  async execute(operation: ChatOperation, body: Record<string, unknown>, cancellation?: AbortSignal, live?: LiveParts): Promise<unknown> {
    if (!Object.hasOwn(chatRequests, operation)) throw new Error("Unsupported chat operation");
    if (operation === "chat.rename" || operation === "chat.fork" || operation === "chat.subtask.snapshot" ||
        operation === "chat.prompt" || operation === "chat.permission.reply" ||
        operation === "chat.question.reply") {
      body = chatRequests[operation].parse(body);
    }
    if (operation === "project.list") {
      const projects = await this.#registry.listVerified();
      return { version: 1, projects: projects.map((w) => this.#registry.public(w)), pathEntry: true };
    }
    if (operation === "project.open") {
      const workspace = await this.#registry.resolvePath(String(body.path));
      return { version: 1, project: this.#registry.public(workspace) };
    }
    const workspace = await this.#registry.get(body.projectId);
    if (operation === "chat.models") {
      const providers = await getProviders(this.#client, this.#registry, workspace);
      const models = providers.flatMap((provider) => Object.values(provider.models).map((model) => {
        const effortLevels = effortLevelsFor(model);
        return { providerID: provider.id, providerName: provider.name,
          modelID: model.id, modelName: model.name,
          ...(effortLevels.length > 0 ? { effortLevels } : {}) };
      }));
      return chatResponses["chat.models"].parse({ version: 1, models: models.slice(0, 200) });
    }
    if (operation === "chat.list") {
      const cursor = this.#cursors.resolve(body, workspace.id);
      // Pinned compatibility shim: the supplied SDK preserves its local fetch
      // and auth, but its legacy method predates this fixed paginated route.
      // This URL is a constant; remote callers cannot supply URLs or SDK methods.
      const options = { ...this.#registry.options(workspace), url: "/api/session",
        query: { directory: workspace.path, limit: 50, ...(cursor ? { cursor } : {}) } };
      const page = nativePage.parse(unwrapResult(await this.#client.session.list(options)));
      for (const session of page.data) {
        if (await realpath(session.location.directory) !== workspace.path) throw new ChatAccessError("access_denied");
      }
      return { version: 1, chats: page.data.filter((s) => !s.parentID).map((s) => toChatSummary(s)),
        cursor: this.#cursors.issue(page.cursor.next, workspace.id) };
    }
    if (operation === "chat.create") {
      const session = unwrapResult(await this.#client.session.create({ ...this.#registry.options(workspace), body: {} }));
      await getSession(this.#client, this.#registry, workspace, session.id);
      return { version: 1, chat: toChatSummary(session) };
    }
    const sessionId = String(body.sessionId);
    const deadline = AbortSignal.timeout(10_000);
    const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline;
    const session = await getSession(this.#client, this.#registry, workspace, sessionId, signal);
    if (operation === "chat.subtask.snapshot") {
      await getChildSession(this.#client, this.#registry, workspace, String(body.parentSessionId), sessionId, signal);
    } else if (session.parentID && ["chat.snapshot", "chat.prompt", "chat.abort", "chat.permission.reply", "chat.question.reply"].includes(operation)) {
      throw new ChatAccessError("access_denied");
    }
    if (operation === "chat.rename" || operation === "chat.fork") {
      return renameOrForkSession(this.#client, this.#registry, workspace, session, sessionId, operation, body, signal);
    }
    if (operation === "chat.get") {
      if (session.parentID) throw new ChatAccessError("access_denied");
      return { version: 1, chat: toChatSummary(session) };
    }
    if (operation === "chat.delete") {
      const ids = await deleteSession(this.#client, this.#registry, workspace, session);
      this.#cursors.forget(ids);
      return { version: 1, deleted: true };
    }
    if (operation === "chat.snapshot" || operation === "chat.subtask.snapshot") {
      return buildChatSnapshot({ client: this.#client, registry: this.#registry, cursors: this.#cursors,
        answeredQuestions: this.#answeredQuestions, workspace, session, sessionId, operation, body, live, signal });
    }
    if (operation === "chat.prompt") {
      const prompt = chatRequests["chat.prompt"].parse(body);
      const sdkBody = await buildPromptRequestBody(prompt, () => getProviders(this.#client, this.#registry, workspace));
      signal.throwIfAborted();
      const result = await this.#client.session.promptAsync({ ...this.#registry.options(workspace), signal,
        path: { id: sessionId }, body: sdkBody as NonNullable<Parameters<Client["session"]["promptAsync"]>[0]["body"]> });
      // The pinned SDK returns an empty 204, not response data, on acceptance.
      if (result.error || result.response.status !== 204) throw new Error("OpenCode prompt was not accepted");
      return { version: 1, accepted: true };
    }
    if (operation === "chat.abort") {
      unwrapResult(await this.#client.session.abort({ ...this.#registry.options(workspace), path: { id: sessionId } }));
      return { version: 1, accepted: true };
    }
    if (operation === "chat.permission.reply") {
      // Schema-enforced above to exactly OpenCode's own choices; passed through
      // unchanged so an explicit "always" is never downgraded.
      const response = body.response as "once" | "always" | "reject";
      const result = await this.#client.postSessionIdPermissionsPermissionId({ ...this.#registry.options(workspace), signal,
        path: { id: sessionId, permissionID: String(body.permissionId) }, body: { response } });
      if (result.error || !result.response.ok) throw new Error("OpenCode permission reply was not accepted");
      return { version: 1, accepted: true };
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentionally tautological today; kept explicit so a new operation cannot fall through
    if (operation === "chat.question.reply") {
      const questionId = String(body.questionId);
      const pending = await resolvePendingQuestion(this.#liveParts, this.#client, this.#registry, workspace, sessionId, questionId, signal, live);
      const { result, recorded } = await replyToQuestion(this.#client, this.#registry, workspace, questionId, body, pending, signal);
      if (recorded) this.#answeredQuestions.record(sessionId, recorded);
      return result;
    }
    operation satisfies never;
    throw new Error("Unsupported chat operation");
  }
}
