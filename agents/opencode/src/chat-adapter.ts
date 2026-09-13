import type { PluginInput } from "@opencode-ai/plugin"
import type { Part, Provider, ToolPart } from "@opencode-ai/sdk"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { chatRequests, chatResponses, chatSummarySchema, projectMcpSnapshotSchema, type ProjectMcpSnapshot,
  type ChatOperation, type ChatSubtask } from "@openremotecode/protocol"
import type { ProjectMcpReader } from "./project-mcp.js"
import type { ChatStreamTarget } from "@openremotecode/protocol"
import { chatMessageContent, permissionSummary, resolveImages, subtaskSummary, todoSummaries } from "./chat-message.js"
import { subtaskStats } from "./chat-subtask.js"
import { LiveParts } from "./live-parts.js"
import { openCodeEvents } from "./opencode-events.js"
import { readMessageHistory } from "./message-history.js"

type Client = PluginInput["client"]
interface Workspace { id: string; name: string; path: string; dev: number; ino: number }
interface Cursor { native: string; projectId: string; sessionId?: string; expires: number }
export class ChatAccessError extends Error {
  constructor(readonly code: "access_denied" | "context_expired" | "chat_not_found" | "chat_busy") { super(code) }
}
export interface ChatAdapter {
  execute(operation: ChatOperation, body: Record<string, unknown>): Promise<unknown>
}

const nativeSummary = z.object({ id: z.string(), title: z.string(), parentID: z.string().optional(),
  time: z.object({ updated: z.number() }) })
const nativePage = z.object({ data: z.array(nativeSummary.extend({
  location: z.object({ directory: z.string() }),
})).max(50), cursor: z.object({ next: z.string().max(16000).nullable() }) })
// The pinned SDK's typed Model has no `variants` field -- it predates
// OpenCode's reasoning-effort "variant" concept -- but the pinned server's
// runtime response still carries it, keyed by variant id: on OpenCode
// 1.18.30, `variants` is a record `{ [variantId]: { reasoningEffort, ... } }`
// (confirmed against a live `GET /config/providers` response), not an array.
// Only the bounded keys ever cross this boundary; each key's own value -- the
// provider-specific request override it maps to internally -- never does.
// See CHAT-MODEL.md.
function effortLevelsFor(model: unknown): string[] {
  const variants = model && typeof model === "object" ? (model as { variants?: unknown }).variants : undefined
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) return []
  const ids = Object.keys(variants).filter((id) => id.length > 0 && id.length <= 128)
  return [...new Set(ids)].slice(0, 10)
}
// AssistantMessage.modelID/providerID/variant exist on OpenCode 1.18.30's
// runtime message info (confirmed against a live session) but the pinned
// SDK's typed message shape doesn't declare them. Only ever read, narrowed
// into the same bounded {providerID, modelID, effort?} shape chat.prompt and
// chat.models already use -- never the raw message object. See CHAT-MODEL.md.
function lastAssistantModel(messages: readonly { info: unknown }[]):
    { providerID: string; modelID: string; effort?: string } | undefined {
  for (const { info } of [...messages].reverse()) {
    if (!info || typeof info !== "object" || (info as { role?: unknown }).role !== "assistant") continue
    const providerID = (info as { providerID?: unknown }).providerID
    const modelID = (info as { modelID?: unknown }).modelID
    const variant = (info as { variant?: unknown }).variant
    const bounded = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128
    if (!bounded(providerID) || !bounded(modelID)) return undefined
    return { providerID: providerID as string, modelID: modelID as string,
      ...(bounded(variant) ? { effort: variant as string } : {}) }
  }
  return undefined
}

export class OpenCodeChatAdapter implements ChatAdapter, ProjectMcpReader {
  readonly #client: Client
  readonly #directories: string[]
  #workspaces: Promise<Workspace[]> | undefined
  readonly #cursors = new Map<string, Cursor>()
  readonly #liveParts = new Map<string, LiveParts>()
  readonly #liveChanged = new Map<string, () => void>()

  constructor(client: Client, directory: string, additionalDirectories: unknown = []) {
    this.#client = client
    const additional = z.array(z.string().min(1).max(4096)).max(99).parse(additionalDirectories)
    this.#directories = [...new Set([directory, ...additional])]
    // eslint-disable-next-line no-control-regex -- deliberately rejects C0 control characters in paths
    if (this.#directories.some((d) => !path.isAbsolute(d) || /[\x00-\x1f]/u.test(d))) {
      throw new ChatAccessError("access_denied")
    }
  }

  async #projects(): Promise<Workspace[]> {
    return this.#workspaces ??= Promise.all(this.#directories.map(async (directory) => {
      const canonical = await realpath(directory)
      const info = await stat(canonical)
      if (!info.isDirectory()) throw new ChatAccessError("access_denied")
      return { id: crypto.randomUUID(), name: path.basename(canonical) || canonical,
        path: canonical, dev: info.dev, ino: info.ino }
    }))
  }
  async #workspace(id: unknown): Promise<Workspace> {
    const workspace = (await this.#projects()).find((entry) => entry.id === id)
    if (!workspace) throw new ChatAccessError("context_expired")
    const canonical = await realpath(workspace.path)
    const info = await stat(canonical)
    if (canonical !== workspace.path || !info.isDirectory() || info.dev !== workspace.dev || info.ino !== workspace.ino) {
      throw new ChatAccessError("access_denied")
    }
    return workspace
  }
  #public(workspace: Workspace) { return { id: workspace.id, name: workspace.name, path: workspace.path } }
  async readProjectMcp(projectId: string, signal: AbortSignal): Promise<ProjectMcpSnapshot> {
    signal.throwIfAborted()
    const workspace = await this.#workspace(projectId).catch((error: unknown) => {
      throw error instanceof ChatAccessError ? error : new ChatAccessError("access_denied")
    })
    signal.throwIfAborted()
    let native: unknown
    try {
      // The pinned root SDK takes query/signal options, unlike the v2 SDK.
      native = this.#data(await this.#client.mcp.status({ query: { directory: workspace.path }, signal }))
    } catch {
      native = undefined
    }
    await this.#workspace(projectId).catch((error: unknown) => {
      throw error instanceof ChatAccessError ? error : new ChatAccessError("access_denied")
    })
    signal.throwIfAborted()
    const unavailable: ProjectMcpSnapshot = { version: 1, projectId, state: "unavailable", servers: [] }
    if (!native || typeof native !== "object" || Array.isArray(native)) return unavailable
    const names = Object.keys(native)
    if (names.length > 100) return unavailable
    // Copy only names and status discriminators. Native errors/config never leave this boundary.
    const servers = names.sort().map((name) => {
      const value: unknown = (native as Record<string, unknown>)[name]
      return { name, status: value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).status : undefined }
    })
    const result = projectMcpSnapshotSchema.safeParse({ version: 1, projectId, state: "ready", servers })
    return result.success ? result.data : unavailable
  }
  #options(workspace: Workspace) {
    return { query: { directory: workspace.path }, signal: AbortSignal.timeout(10_000) }
  }
  #data<T>(result: { data?: T; error?: unknown; response: Response }): NonNullable<T> {
    if (result.error || !result.response.ok || result.data == null) throw new Error("OpenCode operation failed")
    return result.data
  }
  async #providers(workspace: Workspace): Promise<Provider[]> {
    try {
      return this.#data(await this.#client.config.providers(this.#options(workspace))).providers
    } catch {
      // Same spirit as readProjectMcp: a transient provider-config failure
      // yields an empty list, never a leaked native error.
      return []
    }
  }
  #summary(value: unknown) {
    const session = nativeSummary.parse(value)
    // Native fork titles can exceed the wire limit after OpenCode adds its suffix.
    return chatSummarySchema.parse({ id: session.id, title: session.title.slice(0, 512),
      updatedAt: session.time.updated, ...(session.parentID ? { parentId: session.parentID } : {}) })
  }
  #cursor(native: string | null, projectId: string, sessionId?: string) {
    const now = Date.now()
    for (const [key, value] of this.#cursors) if (value.expires <= now) this.#cursors.delete(key)
    if (!native) return null
    for (const [id, cursor] of this.#cursors) {
      if (cursor.native === native && cursor.projectId === projectId && cursor.sessionId === sessionId) {
        cursor.expires = now + 300000
        return id
      }
    }
    if (this.#cursors.size >= 256) throw new ChatAccessError("context_expired")
    const id = crypto.randomUUID()
    this.#cursors.set(id, { native, projectId, ...(sessionId ? { sessionId } : {}), expires: now + 300000 })
    return id
  }
  #nativeCursor(body: Record<string, unknown>, workspace: Workspace, sessionId?: string) {
    if (!body.cursor) return undefined
    if (typeof body.cursor !== "string") throw new ChatAccessError("context_expired")
    const cursor = this.#cursors.get(body.cursor)
    if (!cursor || cursor.expires <= Date.now() || cursor.projectId !== workspace.id || cursor.sessionId !== sessionId) {
      throw new ChatAccessError("context_expired")
    }
    return cursor.native
  }
  async #session(workspace: Workspace, sessionId: string, signal = AbortSignal.timeout(10_000)) {
    signal.throwIfAborted()
    const response = await this.#client.session.get({ ...this.#options(workspace), signal, path: { id: sessionId } })
    if (response.response.status === 404) throw new ChatAccessError("chat_not_found")
    const result = this.#data(response)
    // OpenCode's session-by-ID APIs do not enforce directory membership.
    if (result.id !== sessionId || await realpath(result.directory) !== workspace.path) {
      throw new ChatAccessError("access_denied")
    }
    return result
  }
  async #child(workspace: Workspace, parentId: string, sessionId: string, signal: AbortSignal) {
    if (parentId === sessionId) throw new ChatAccessError("access_denied")
    await this.#session(workspace, parentId, signal)
    const child = await this.#session(workspace, sessionId, signal)
    if (child.parentID !== parentId) throw new ChatAccessError("access_denied")
    return child
  }
  // OpenCode's own per-session task list. Unlike a pending permission this is
  // readable on demand, so a cold snapshot recovers it without having been
  // subscribed when it was written. A transient failure yields an empty list,
  // never a leaked native error -- the same spirit as readProjectMcp.
  async #todos(workspace: Workspace, sessionId: string, signal: AbortSignal) {
    try {
      return todoSummaries(this.#data(await this.#client.session.todo({ ...this.#options(workspace), signal,
        path: { id: sessionId } })))
    } catch {
      return []
    }
  }
  async #subtasks(workspace: Workspace, parentId: string, parts: Part[],
    statuses: Record<string, { type: string }>, signal: AbortSignal) {
    const tasks = parts.filter((part): part is ToolPart => part.type === "tool" && part.tool === "task")
    const result = new Map<string, ChatSubtask>()
    // A single snapshot has one deadline and at most eight child reads. No
    // recursive enrichment, unbounded history walk, cache, or background polling.
    for (const part of tasks.slice(-8)) {
      const task = subtaskSummary(part)
      const id = part.state.status !== "pending" ? part.state.metadata?.sessionId : undefined
      if (typeof id !== "string" || !id || id.length > 128) continue
      try {
        await this.#child(workspace, parentId, id, signal)
        const response = await this.#client.session.messages({ query: { directory: workspace.path, limit: 100 },
          path: { id }, signal })
        const messages = this.#data(response)
        if (!Array.isArray(messages) || messages.length > 100 || messages.some((message) =>
          message.info.sessionID !== id || !Array.isArray(message.parts) || message.parts.some((p) => p.sessionID !== id))) {
          throw new ChatAccessError("access_denied")
        }
        const stats = subtaskStats(messages, !response.response.headers.get("x-next-cursor"))
        await this.#child(workspace, parentId, id, signal)
        const status = statuses[id]?.type
        result.set(part.id, { ...task, sessionId: id,
          status: status === "busy" ? "running" : status === "retry" ? "retry" : task.status,
          stats: task.status === "completed" && status !== "busy" && status !== "retry"
            ? stats : { toolCalls: stats.toolCalls, complete: stats.complete } })
      } catch {
        // Deleted/unavailable/foreign children do not discard the parent chat.
        // Unverified IDs, child content and exception details never escape.
        result.set(part.id, { ...task, ...(task.background ? { status: "unknown" } : {}) })
      }
    }
    return result
  }
  async #delete(workspace: Workspace, session: Awaited<ReturnType<Client["session"]["get"]>>["data"]): Promise<void> {
    if (!session || session.parentID) throw new ChatAccessError("access_denied")
    const options = { query: { directory: workspace.path }, signal: AbortSignal.timeout(10_000) }
    const ids = new Set([session.id])
    // OpenCode deletes descendants too. Validate the complete bounded tree
    // before allowing that cascade to touch another workspace or running work.
    for (const id of ids) {
      options.signal.throwIfAborted()
      const children = this.#data(await this.#client.session.children({ ...options, path: { id } }))
      if (!Array.isArray(children) || children.length > 255) throw new ChatAccessError("access_denied")
      for (const child of children) {
        if (child.parentID !== id || ids.has(child.id) || ids.size >= 256 ||
            await realpath(child.directory) !== workspace.path) throw new ChatAccessError("access_denied")
        ids.add(child.id)
      }
    }
    const statuses = this.#data(await this.#client.session.status(options))
    if ([...ids].some((id) => statuses[id] && statuses[id].type !== "idle")) throw new ChatAccessError("chat_busy")
    await this.#workspace(workspace.id)
    if (!this.#data(await this.#client.session.delete({ ...options, path: { id: session.id } }))) {
      throw new Error("OpenCode deletion was not confirmed")
    }
    for (const id of ids) {
      const result = await this.#client.session.get({ ...options, path: { id } })
      if (result.response.status !== 404) throw new Error("OpenCode deletion was not confirmed")
    }
    for (const [key, cursor] of this.#cursors) if (cursor.sessionId && ids.has(cursor.sessionId)) this.#cursors.delete(key)
  }
  async readChat(target: ChatStreamTarget, signal: AbortSignal, reconcile = false): Promise<unknown> {
    const { subscriptionId, parentSessionId, includeSubtasks, ...body } = target
    const live = this.#liveParts.get(subscriptionId)
    const workspace = await this.#workspace(target.projectId)
    const options = { includeTools: target.includeTools === true, includeShell: target.includeShell === true,
      includeActivities: target.includeActivities === true, includePermissions: target.includePermissions === true,
      includeTodos: target.includeTodos === true, directory: workspace.path }
    if (live?.snapshot && !reconcile && !live.needsSnapshot) {
      // Authenticate each batch, but don't reread all messages or child tools to
      // deliver a text delta already received from the authorized source stream.
      const session = parentSessionId ? await this.#child(workspace, parentSessionId, target.sessionId, signal)
        : await this.#session(workspace, target.sessionId, signal)
      if (!parentSessionId && session.parentID) throw new ChatAccessError("access_denied")
      await this.#workspace(target.projectId)
      if (parentSessionId) await this.#child(workspace, parentSessionId, target.sessionId, signal)
      else if ((await this.#session(workspace, target.sessionId, signal)).parentID) throw new ChatAccessError("access_denied")
      signal.throwIfAborted()
      const result = live.project({ ...live.snapshot, chat: this.#summary(session) }, options)
      if (live.reconcileSoon) {
        live.reconcileSoon = false
        live.needsSnapshot = true
        this.#liveChanged.get(subscriptionId)?.()
      }
      return result
    }
    const revision = live?.snapshotRevision ?? 0
    const result = chatResponses["chat.snapshot"].parse(await this.execute(parentSessionId ? "chat.subtask.snapshot" : "chat.snapshot",
      { ...body, ...(parentSessionId ? { parentSessionId } : includeSubtasks !== undefined ? { includeSubtasks } : {}) },
      signal, live))
    live?.remember(result, revision)
    return live ? live.project(result, options) : result
  }
  async watchChat(target: ChatStreamTarget, signal: AbortSignal, changed: (reset: boolean) => void): Promise<void> {
    const workspace = await this.#workspace(target.projectId)
    if (target.parentSessionId) await this.#child(workspace, target.parentSessionId, target.sessionId, signal)
    else if ((await this.#session(workspace, target.sessionId, signal)).parentID) throw new ChatAccessError("access_denied")
    signal.throwIfAborted()
    // Use the supplied local SDK transport and canonical project context. No
    // public OpenCode listener or provider request is introduced.
    const live = new LiveParts(target.sessionId)
    this.#liveParts.set(target.subscriptionId, live)
    this.#liveChanged.set(target.subscriptionId, () => { changed(false); })
    try {
      for await (const raw of openCodeEvents(this.#client, workspace.path, signal)) {
        if (signal.aborted) return
        // Pinned compatibility boundary: runtime v1/v2 event shapes are normalized
        // here. Event text/metadata never escapes through this invalidation hook.
        const event = raw as { type: string; properties?: { sessionID?: string;
          part?: { sessionID?: string }; info?: { id?: string; sessionID?: string } } }
        const p = event.properties
        if (event.type === "server.connected") { changed(false); continue }
        if (event.type === "server.instance.disposed") throw new Error("Chat source disposed")
        const id = p?.sessionID ?? p?.part?.sessionID ?? p?.info?.sessionID ?? p?.info?.id
        if (id !== target.sessionId) continue
        live.capture(raw)
        if (event.type.startsWith("message.") || event.type.startsWith("session.") ||
            event.type.startsWith("permission.") || event.type.startsWith("todo.")) {
          changed(event.type === "message.removed" || event.type === "message.part.removed" || event.type === "session.compacted")
        }
      }
      if (!signal.aborted) throw new Error("Chat event stream ended")
    } finally {
      if (this.#liveParts.get(target.subscriptionId) === live) {
        this.#liveParts.delete(target.subscriptionId)
        this.#liveChanged.delete(target.subscriptionId)
      }
      live.clear()
    }
  }
  async execute(operation: ChatOperation, body: Record<string, unknown>, cancellation?: AbortSignal, live?: LiveParts): Promise<unknown> {
    if (!Object.hasOwn(chatRequests, operation)) throw new Error("Unsupported chat operation")
    if (operation === "chat.rename" || operation === "chat.fork" || operation === "chat.subtask.snapshot" ||
        operation === "chat.prompt" || operation === "chat.permission.reply") {
      body = chatRequests[operation].parse(body)
    }
    if (operation === "project.list") {
      const projects = await this.#projects()
      for (const project of projects) await this.#workspace(project.id)
      return { version: 1, projects: projects.map((w) => this.#public(w)), pathEntry: true }
    }
    if (operation === "project.open") {
      const entered = String(body.path)
      // eslint-disable-next-line no-control-regex -- deliberately rejects C0 control characters in paths
      if (!path.isAbsolute(entered) || /[\x00-\x1f]/u.test(entered)) throw new ChatAccessError("access_denied")
      const canonical = await realpath(entered).catch(() => { throw new ChatAccessError("access_denied") })
      const workspace = (await this.#projects()).find((w) => w.path === canonical)
      if (!workspace) throw new ChatAccessError("access_denied")
      await this.#workspace(workspace.id)
      return { version: 1, project: this.#public(workspace) }
    }
    const workspace = await this.#workspace(body.projectId)
    if (operation === "chat.models") {
      const providers = await this.#providers(workspace)
      const models = providers.flatMap((provider) => Object.values(provider.models).map((model) => {
        const effortLevels = effortLevelsFor(model)
        return { providerID: provider.id, providerName: provider.name,
          modelID: model.id, modelName: model.name,
          ...(effortLevels.length > 0 ? { effortLevels } : {}) }
      }))
      return chatResponses["chat.models"].parse({ version: 1, models: models.slice(0, 200) })
    }
    if (operation === "chat.list") {
      const cursor = this.#nativeCursor(body, workspace)
      // Pinned compatibility shim: the supplied SDK preserves its local fetch
      // and auth, but its legacy method predates this fixed paginated route.
      // This URL is a constant; remote callers cannot supply URLs or SDK methods.
      const options = { ...this.#options(workspace), url: "/api/session",
        query: { directory: workspace.path, limit: 50, ...(cursor ? { cursor } : {}) } }
      const page = nativePage.parse(this.#data(await this.#client.session.list(options)))
      for (const session of page.data) {
        if (await realpath(session.location.directory) !== workspace.path) throw new ChatAccessError("access_denied")
      }
      return { version: 1, chats: page.data.filter((s) => !s.parentID).map((s) => this.#summary(s)),
        cursor: this.#cursor(page.cursor.next, workspace.id) }
    }
    if (operation === "chat.create") {
      const session = this.#data(await this.#client.session.create({ ...this.#options(workspace), body: {} }))
      await this.#session(workspace, session.id)
      return { version: 1, chat: this.#summary(session) }
    }
    const sessionId = String(body.sessionId)
    const deadline = AbortSignal.timeout(10_000)
    const signal = cancellation ? AbortSignal.any([deadline, cancellation]) : deadline
    const session = await this.#session(workspace, sessionId, signal)
    if (operation === "chat.subtask.snapshot") {
      await this.#child(workspace, String(body.parentSessionId), sessionId, signal)
    } else if (session.parentID && ["chat.snapshot", "chat.prompt", "chat.abort", "chat.permission.reply"].includes(operation)) {
      throw new ChatAccessError("access_denied")
    }
    if (operation === "chat.rename" || operation === "chat.fork") {
      if (session.parentID) throw new ChatAccessError("access_denied")
      const options = { query: { directory: workspace.path }, signal }
      await this.#workspace(workspace.id)
      if (operation === "chat.fork") {
        // Idle sessions are absent from the pinned SDK's authoritative status map.
        const statuses = z.record(z.string(), z.object({ type: z.enum(["idle", "busy", "retry"]) }))
          .parse(this.#data(await this.#client.session.status(options)))
        if (statuses[sessionId] && statuses[sessionId].type !== "idle") throw new ChatAccessError("chat_busy")
        await this.#workspace(workspace.id)
        if ((await this.#session(workspace, sessionId, signal)).parentID) throw new ChatAccessError("access_denied")
      }
      signal.throwIfAborted()
      try {
        const result = this.#data(operation === "chat.rename"
          ? await this.#client.session.update({ ...options, path: { id: sessionId }, body: { title: String(body.title) } })
          // Omitting messageID copies the full history, not a caller-selected prefix.
          : await this.#client.session.fork({ ...options, path: { id: sessionId }, body: {} }))
        this.#summary(result)
        if (result.parentID || await realpath(result.directory) !== workspace.path ||
            (operation === "chat.rename" ? result.id !== sessionId || result.title !== body.title : result.id === sessionId)) {
          throw new Error("OpenCode mutation was not confirmed")
        }
        await this.#workspace(workspace.id)
        const confirmed = await this.#session(workspace, result.id, signal)
        if (confirmed.parentID || (operation === "chat.rename" && confirmed.title !== body.title)) {
          throw new Error("OpenCode mutation was not confirmed")
        }
        signal.throwIfAborted()
        return { version: 1, chat: this.#summary(confirmed) }
      } catch {
        // Once dispatched, even failed membership/readback checks are uncertain.
        throw new Error("OpenCode mutation was not confirmed")
      }
    }
    if (operation === "chat.get") {
      if (session.parentID) throw new ChatAccessError("access_denied")
      return { version: 1, chat: this.#summary(session) }
    }
    if (operation === "chat.delete") {
      await this.#delete(workspace, session)
      return { version: 1, deleted: true }
    }
    if (operation === "chat.snapshot" || operation === "chat.subtask.snapshot") {
      const before = this.#nativeCursor(body, workspace, sessionId)
      const history = await readMessageHistory(this.#client, workspace.path, sessionId, before, signal)
      const messages = history.messages
      const statuses = this.#data(await this.#client.session.status({ ...this.#options(workspace), signal }))
      const todos = body.includeTodos === true ? await this.#todos(workspace, sessionId, signal) : undefined
      const subtasks = body.includeSubtasks === true || operation === "chat.subtask.snapshot"
        ? await this.#subtasks(workspace, sessionId,
          messages.filter((m) => m.info.role === "assistant").flatMap((m) => m.parts.slice(0, 100)), statuses,
          AbortSignal.any([signal, AbortSignal.timeout(4000)])) : undefined
      // Recheck membership after concurrent SDK reads, too.
      await this.#workspace(workspace.id)
      if (operation === "chat.subtask.snapshot") {
        await this.#child(workspace, String(body.parentSessionId), sessionId, signal)
      } else if ((await this.#session(workspace, sessionId, signal)).parentID) {
        throw new ChatAccessError("access_denied")
      }
      if (live) {
        for (const { info } of messages) if (info.role === "assistant" && info.time?.completed !== undefined) live.next.remove(info.id)
      }
      // Only the unpaginated (latest-page) fetch reliably contains the true
      // most recent reply; an earlier-history page must not report a stale
      // model as if it were current.
      const model = before === undefined ? lastAssistantModel(messages) : undefined
      return { version: 1, chat: this.#summary(session),
        cursor: this.#cursor(history.cursor, workspace.id, sessionId),
        status: statuses[sessionId]?.type ?? "idle",
        ...(model ? { model } : {}),
        // v1 has no endpoint to list pending permissions; the event-captured
        // value on the live subscription (if any) is the only source. See
        // CHAT-PERMISSIONS.md.
        ...(body.includePermissions === true
          ? { permission: live?.permission ? permissionSummary(live.permission) : null } : {}),
        // A live subscription's event-captured list, when it has one, is at
        // least as current as this read. See CHAT-TODOS.md.
        ...(todos ? { todos: live?.todos ?? todos } : {}),
        messages: await Promise.all(messages.map(async ({ info, parts }) => {
          if (info.sessionID !== sessionId) throw new ChatAccessError("access_denied")
          if (live) parts = live.overlay(info.id, parts, info.role === "assistant" && info.time?.completed !== undefined)
          // Image decode/resize is CPU-bound async work; only ever awaited here,
          // never on the live streaming overlay path (see chat-message.ts).
          const images = body.includeImages === true ? await resolveImages(parts) : undefined
          const agent = info.role === "user" ? info.agent : info.mode
          return { id: info.id, role: info.role, ...chatMessageContent(info.role, parts, subtasks,
            { includeTools: body.includeTools === true, includeShell: body.includeShell === true,
              includeActivities: body.includeActivities === true, ...(images ? { images } : {}),
              messageFinished: info.role === "assistant" && info.time?.completed !== undefined,
              directory: workspace.path }),
            ...(agent === "build" || agent === "plan" ? { mode: agent } : {}),
            ...(live?.incomplete(info.id) ? { incomplete: true } : {}) }
        })) }
    }
    if (operation === "chat.prompt") {
      const prompt = chatRequests["chat.prompt"].parse(body)
      const sdkBody: NonNullable<Parameters<Client["session"]["promptAsync"]>[0]["body"]> = {
        parts: [{ type: "text", text: prompt.text }],
      }
      if (prompt.mode === "build") sdkBody.agent = "build"
      if (prompt.mode === "plan") sdkBody.agent = "plan"
      if (prompt.model) {
        const { providerID, modelID, effort } = prompt.model
        sdkBody.model = { providerID, modelID }
        if (effort) {
          // Re-validate against the model's currently reported variants before
          // forwarding -- never trust a stale client-asserted effort id, even
          // though the mobile client already only offers ids chat.models gave it.
          const providers = await this.#providers(workspace)
          const model = providers.find((p) => p.id === providerID)?.models[modelID]
          if (!model || !effortLevelsFor(model).includes(effort)) {
            throw new Error("Unsupported reasoning effort for this model")
          }
          // `variant` is a top-level PromptInput field, a sibling of `model`/
          // `agent`/`parts` -- not nested under `model`. The pinned SDK's body
          // type predates it, hence the cast; OpenCode's own prompt schema
          // (session/prompt.ts) declares it as an optional string.
          ;(sdkBody as Record<string, unknown>).variant = effort
        }
      }
      signal.throwIfAborted()
      const result = await this.#client.session.promptAsync({ ...this.#options(workspace), signal,
        path: { id: sessionId }, body: sdkBody })
      // The pinned SDK returns an empty 204, not response data, on acceptance.
      if (result.error || result.response.status !== 204) throw new Error("OpenCode prompt was not accepted")
      return { version: 1, accepted: true }
    }
    if (operation === "chat.abort") {
      this.#data(await this.#client.session.abort({ ...this.#options(workspace), path: { id: sessionId } }))
      return { version: 1, accepted: true }
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentionally tautological today; see comment below on why it must stay explicit
    if (operation === "chat.permission.reply") {
      // Never "always": a persistent grant is outside scope. Schema-enforced
      // above; re-asserted here so a future enum widening can't silently
      // reach OpenCode without a corresponding review of this comment.
      const response: "once" | "reject" = body.response === "once" ? "once" : "reject"
      const result = await this.#client.postSessionIdPermissionsPermissionId({ ...this.#options(workspace), signal,
        path: { id: sessionId, permissionID: String(body.permissionId) }, body: { response } })
      if (result.error || !result.response.ok) throw new Error("OpenCode permission reply was not accepted")
      return { version: 1, accepted: true }
    }
    operation satisfies never
    throw new Error("Unsupported chat operation")
  }
}
