import type { Part } from "@opencode-ai/sdk";
import type { ChatStreamUpdate, ChatTodo } from "@openremotecode/protocol";
import { boundedMessageParts, chatMessageContent, permissionSummary, todoSummaries,
  type PermissionRequest, type QuestionRequest } from "./chat-message.js";
import { NextActivity } from "./next-activity.js";

type Snapshot = ChatStreamUpdate["snapshot"]
type Presentation = NonNullable<Parameters<typeof chatMessageContent>[3]>

// OpenCode persists some text only at completion. This bounded, subscription-
// scoped projection overlays live deltas on authorized native snapshot reads.
// Only text/reasoning fields are retained; provider metadata is never copied.
export class LiveParts {
  readonly parts = new Map<string, Part>();
  readonly #seeded = new Set<string>();
  readonly #incomplete = new Set<string>();
  readonly next: NextActivity;
  readonly #roles = new Map<string, "assistant" | "user">();
  readonly #finished = new Set<string>();
  readonly #seenInSnapshot = new Set<string>();
  snapshot: Snapshot | undefined;
  snapshotRevision = 0;
  needsSnapshot = true;
  reconcileSoon = false;
  #status: Snapshot["status"] | undefined;
  // v1 OpenCode has no endpoint to list pending permissions -- this event-
  // captured value is the only source of truth. See CHAT-PERMISSIONS.md.
  //
  // OpenCode can hold several requests for one session at once (parallel tool calls
  // each ask), and every one blocks its tool until answered. All are kept, and the
  // oldest is the one presented: answering it surfaces the next, so none is stranded.
  readonly #permissions = new Map<string, PermissionRequest>();
  readonly #answeredPermissions = new Set<string>();
  get permission(): PermissionRequest | undefined { return this.#permissions.values().next().value; }
  // Requests OpenCode itself reports as pending that no captured event told this
  // subscription about -- asked before it (re)started. Only ever adds: a request
  // answered since is removed by its own reply event, never by being absent here, so
  // a list read racing a fresh event cannot drop it.
  adoptPermissions(pending: readonly PermissionRequest[]): void {
    for (const request of pending) {
      // A list read that raced a reply can still contain the answered request, and its
      // reply event has already passed, so it would otherwise linger as a stale prompt.
      if (this.#permissions.has(request.id) || this.#answeredPermissions.has(request.id)) continue;
      if (this.#permissions.size >= 64) throw new Error("Live permission limit");
      this.#permissions.set(request.id, request);
    }
  }
  // OpenCode's "todo.updated" carries the complete replacement list, so a
  // captured one is always at least as current as the last snapshot read and
  // supersedes it. Unlike a permission, the list is also readable on demand
  // (see the adapter's #todos), so this only shortens the path. See CHAT-TODOS.md.
  #todos: ChatTodo[] | undefined;
  get todos(): ChatTodo[] | undefined { return this.#todos; }
  // A pending question, captured the same way a permission is. OpenCode does expose a
  // pending-question list, but the event is the lower-latency source and matches how the
  // permission path already works. See ADR 0011.
  #question: QuestionRequest | undefined;
  get question(): QuestionRequest | undefined { return this.#question; }
  constructor(readonly sessionId: string) { this.next = new NextActivity(sessionId); }
  #invalidate() { this.needsSnapshot = true; this.snapshotRevision++; }
  capture(raw: unknown): void {
    const event = raw as { id?: unknown; type?: string; properties?: Record<string, any> };
    const properties = event?.properties;
    if (!properties) return;
    if (this.next.capture(event.type ?? "", properties, event.id)) {
      if (event.type?.endsWith(".ended") || event.type?.endsWith(".failed")) this.reconcileSoon = true;
      return;
    }
    if (event.type === "session.status" && properties.sessionID === this.sessionId) {
      if (["idle", "busy", "retry"].includes(properties.status?.type)) {
        this.#status = properties.status.type;
        if (![...this.next.messages.values()].some((m) => m.running)) this.next.status = undefined;
        if (this.#status === "idle") this.reconcileSoon = true;
      }
      return;
    }
    // The SDK's generated types call this "permission.updated" with a
    // {id, type, pattern, title, ...} payload, but the pinned 1.18.30 binary
    // actually emits "permission.asked" with a differently-shaped payload
    // ({id, sessionID, permission, patterns, ...}, no title at all) --
    // confirmed via `strings` on the binary and live event capture. Both
    // event names are accepted in case a future build reconciles the naming.
    if (event.type === "permission.asked" || event.type === "permission.updated") {
      if (properties.sessionID === this.sessionId && typeof properties.id === "string") {
        if (!this.#permissions.has(properties.id) && this.#permissions.size >= 64) throw new Error("Live permission limit");
        this.#permissions.set(properties.id, properties as PermissionRequest);
        this.reconcileSoon = true;
      }
      return;
    }
    if (event.type === "question.asked") {
      if (properties.sessionID === this.sessionId && typeof properties.id === "string") {
        this.#question = properties as QuestionRequest;
        this.reconcileSoon = true;
      }
      return;
    }
    if (event.type === "question.replied" || event.type === "question.rejected") {
      const answeredId = properties.requestID ?? properties.id;
      if (properties.sessionID === this.sessionId && answeredId === this.#question?.id) {
        this.#question = undefined;
        this.reconcileSoon = true;
      }
      return;
    }
    if (event.type === "todo.updated") {
      if (properties.sessionID === this.sessionId) this.#todos = todoSummaries(properties.todos);
      return;
    }
    if (event.type === "permission.replied") {
      // The reply event's id field wasn't directly observed live; accept
      // either name the SDK types vs. the binary's internal bus schema use.
      const repliedId = properties.permissionID ?? properties.requestID;
      if (properties.sessionID === this.sessionId && typeof repliedId === "string") {
        // Bounded, oldest forgotten first: only the last few answers can still race a read.
        this.#answeredPermissions.delete(repliedId);
        this.#answeredPermissions.add(repliedId);
        if (this.#answeredPermissions.size > 128) {
          for (const oldest of this.#answeredPermissions) { this.#answeredPermissions.delete(oldest); break; }
        }
        if (this.#permissions.delete(repliedId)) this.reconcileSoon = true;
      }
      return;
    }
    if (event.type === "message.updated") {
      const info = properties.info;
      if (info?.sessionID !== this.sessionId || typeof info.id !== "string" || !info.id || info.id.length > 128 ||
          !["user", "assistant"].includes(info.role)) return;
      if (!this.#roles.has(info.id) && this.#roles.size >= 1000) throw new Error("Live message limit");
      this.#roles.set(info.id, info.role);
      if (info.role === "user") this.#invalidate();
      if (info.time?.completed !== undefined) { this.#finished.add(info.id); this.reconcileSoon = true; }
      return;
    }
    if (event.type === "message.part.removed") {
      if (properties.sessionID !== this.sessionId) return;
      this.parts.delete(properties.partID);
      this.#seeded.delete(properties.partID);
      this.#incomplete.delete(properties.partID);
      this.#invalidate();
      return;
    }
    if (event.type === "message.removed") {
      if (properties.sessionID !== this.sessionId) return;
      this.next.remove(properties.messageID);
      this.#roles.delete(properties.messageID);
      this.#finished.delete(properties.messageID);
      this.#invalidate();
      for (const [id, part] of this.parts) {if (part.messageID === properties.messageID) {
        this.parts.delete(id);
        this.#seeded.delete(id);
        this.#incomplete.delete(id);
      }}
      return;
    }
    if (event.type === "message.part.updated") {
      const part = properties.part;
      if (part?.sessionID === this.sessionId && !["text", "reasoning"].includes(part.type)) this.#invalidate();
      if (part?.sessionID !== this.sessionId || !["text", "reasoning"].includes(part.type) ||
          typeof part.id !== "string" || part.id.length > 128 || typeof part.messageID !== "string" ||
          part.messageID.length > 128 || typeof part.text !== "string") return;
      if (!this.parts.has(part.id) && this.parts.size >= 1000) throw new Error("Live part limit");
      const value = { id: part.id, sessionID: this.sessionId, messageID: part.messageID, type: part.type,
        text: part.text.slice(0, 48001), ...(part.synthetic === true ? { synthetic: true } : {}),
        ...(part.ignored === true ? { ignored: true } : {}),
        ...(part.time ? { time: { start: part.time.start, ...(part.time.end !== undefined ? { end: part.time.end } : {}) } } : {}) };
      this.parts.set(part.id, value);
      if (!this.#roles.has(part.messageID) || this.#roles.get(part.messageID) === "user") this.#invalidate();
      this.#seeded.delete(part.id);
      this.#incomplete.delete(part.id);
    } else if (event.type === "message.part.delta" && properties.sessionID === this.sessionId && properties.field === "text") {
      const part = this.parts.get(properties.partID);
      if (!part || part.messageID !== properties.messageID || !["text", "reasoning"].includes(part.type) ||
          typeof properties.delta !== "string") return;
      if (part.type === "text" || part.type === "reasoning") {
        if (this.#seeded.has(part.id)) this.#incomplete.add(part.id);
        part.text = (part.text + properties.delta.slice(0, Math.max(0, 48001 - part.text.length))).slice(0, 48001);
      }
    } else if (["session.next.tool.input.delta", "session.next.compaction.delta"].includes(event.type ?? "")) {
      // These fields are outside the presentation allowlist. They must not
      // trigger expensive history/subtask reads for each private input token.
      return;
    } else if (event.type?.startsWith("session.") && properties.sessionID === this.sessionId) {
      this.#invalidate();
    }
    let size = 0;
    for (const part of this.parts.values()) if (part.type === "text" || part.type === "reasoning") size += part.text.length;
    if (size > 480000) throw new Error("Live text limit");
  }
  overlay(messageId: string, native: Part[], completed = false): Part[] {
    if (completed) {
      this.#finished.add(messageId);
      const retained = new Set(native.map((p) => p.id));
      for (const [id, part] of this.parts) {if (part.messageID === messageId && !retained.has(id)) {
        this.parts.delete(id); this.#seeded.delete(id); this.#incomplete.delete(id);
      }}
    }
    for (const part of native) {
      if (completed) {
        this.capture({ type: "message.part.updated", properties: { part } });
      } else if (!this.parts.has(part.id)) {
        this.capture({ type: "message.part.updated", properties: { part } });
        if (this.parts.has(part.id)) this.#seeded.add(part.id);
      }
    }
    const result = new Map(native.map((part) => [part.id, part]));
    for (const [id, part] of this.parts) if (part.messageID === messageId) result.set(id, part);
    return [...result.values()];
  }
  incomplete(messageId: string): boolean {
    return this.next.incomplete(messageId) || [...this.#incomplete].some((id) => this.parts.get(id)?.messageID === messageId);
  }

  remember(snapshot: Snapshot, revision: number, completed: string[] = []) {
    this.snapshot = snapshot;
    const retained = new Set(snapshot.messages.map((m) => m.id));
    // Do not append previously persisted, now-older messages after the latest
    // page. Keep only genuinely new in-flight messages outside that page.
    for (const id of this.#seenInSnapshot) {if (!retained.has(id)) {
      this.#roles.delete(id); this.#finished.delete(id); this.#seenInSnapshot.delete(id);
      this.next.remove(id);
      for (const [partId, part] of this.parts) {if (part.messageID === id) {
        this.parts.delete(partId); this.#seeded.delete(partId); this.#incomplete.delete(partId);
      }}
    }}
    for (const message of snapshot.messages) this.#roles.set(message.id, message.role);
    for (const id of retained) this.#seenInSnapshot.add(id);
    for (const id of completed) this.next.remove(id);
    if (![...this.next.messages.values()].some((m) => m.running)) {
      this.#status = snapshot.status;
      this.next.status = undefined;
    }
    if (revision === this.snapshotRevision) this.needsSnapshot = false;
  }

  project(snapshot: Snapshot, options: Presentation & { includePermissions?: boolean; includeTodos?: boolean }): Snapshot {
    const messages = new Map(snapshot.messages.map((m) => [m.id, m]));
    // An interrupted run leaves its in-flight tool part marked "running" in
    // OpenCode's stored history for good; idle with nothing waiting on the
    // user is what separates an abandoned part from a blocked one. Every
    // input here is event-captured, so this costs no native read. See ADR 0012.
    const settled = (this.next.status ?? this.#status ?? snapshot.status) === "idle" &&
      !this.permission && !this.#question;
    for (const [id, role] of this.#roles) {if (role === "assistant" && !messages.has(id) &&
      [...this.parts.values()].some((p) => p.messageID === id)) {
      messages.set(id, { id, role, text: "", truncated: false });
    }}
    for (const id of this.next.messages.keys()) {if (!messages.has(id)) {
      messages.set(id, { id, role: "assistant", text: "", truncated: false });
    }}
    const projected = [...messages.values()].slice(-10).map((message) => {
      if (message.role !== "assistant") return message;
      const native = [...this.parts.values()].filter((p) => p.messageID === message.id);
      const legacy = native.flatMap((p) => {
        const content = chatMessageContent("assistant", [p], undefined, { ...options,
          messageFinished: this.#finished.has(message.id), sessionSettled: settled });
        // Text-only projection normally omits parts; preserve its original ID.
        return content.parts ?? (content.text ? [{ id: p.id, type: "text" as const, text: content.text }] : []);
      });
      const next = this.next.parts(message.id).map((part) => {
        // Images never carry an activity; NextActivity never actually produces
        // one, but the shared part type includes it, so it must be excluded here too.
        if (options.includeActivities || part.type === "text" || part.type === "image") return part;
        const { activity: _activity, ...rest } = part;
        return rest;
      });
      if (!legacy.length && !next.length) return message;
      const base = message.parts ?? (legacy.length ? legacy : message.text ? [{ id: `${message.id.slice(0, 120)}-text`, type: "text" as const, text: message.text }] : []);
      const owned = new Set(next.map((p) => p.type));
      const queues = new Map([...owned].map((type) => [type, next.filter((p) => p.type === type)]));
      const used = new Set<string>();
      const parts = base.flatMap((part) => {
        const value = owned.has(part.type) ? queues.get(part.type)?.shift() : legacy.find((p) => p.id === part.id) ?? part;
        if (!value) return [];
        used.add(value.id);
        return [value];
      });
      for (const part of [...legacy.filter((p) => !owned.has(p.type)), ...next]) {
        if (!used.has(part.id)) { parts.push(part); used.add(part.id); }
      }
      const { incomplete: _incomplete, ...baseMessage } = message;
      return { ...baseMessage, ...boundedMessageParts(parts, message.truncated),
        ...(this.incomplete(message.id) ? { incomplete: true } : {}) };
    });
    // Drop whatever the remembered snapshot carried and decide fresh: it's
    // opt-in per this request, and the event-tracked value is always more
    // current than an older remembered read.
    // Drop whatever the remembered snapshot carried for these and decide
    // fresh: each is opt-in per this request, and an event-captured value is
    // always at least as current as an older remembered read.
    const { permission: _rememberedPermission, todos: rememberedTodos, ...rest } = snapshot;
    return { ...rest, status: this.next.status ?? this.#status ?? snapshot.status, messages: projected,
      ...(options.includePermissions
        ? { permission: this.permission ? permissionSummary(this.permission) : null } : {}),
      ...(options.includeTodos ? { todos: this.#todos ?? rememberedTodos ?? [] } : {}) };
  }
  clear() {
    this.parts.clear(); this.#roles.clear(); this.#finished.clear(); this.#seenInSnapshot.clear(); this.#seeded.clear(); this.#incomplete.clear();
    this.next.clear(); this.snapshot = undefined; this.#todos = undefined;
  }
}
