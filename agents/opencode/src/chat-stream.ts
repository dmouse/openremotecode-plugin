import { chatResponses, chatStreamUpdateSchema, type ChatStreamTarget, type ChatStreamUpdate } from "@openremotecode/protocol";
import { ChatAccessError } from "./chat-adapter.js";

export interface ChatStreamReader {
  readChat(target: ChatStreamTarget, signal: AbortSignal, reconcile?: boolean): Promise<unknown>
  watchChat(target: ChatStreamTarget, signal: AbortSignal, changed: (reset: boolean) => void): Promise<void>
}
type Snapshot = ChatStreamUpdate["snapshot"]
interface Subscription { target: ChatStreamTarget; controller: AbortController; revision: number;
  snapshot?: Snapshot; dirty: boolean; reset: boolean; pending: boolean;
  ready?: Promise<void>;
  resetRevision?: number;
  timer?: ReturnType<typeof setTimeout>; expiry?: ReturnType<typeof setTimeout> }
// Reservations survive relay replacement and uncooperative SDK cancellation.
const readers = new WeakMap<ChatStreamReader, number>();
const watchers = new WeakMap<ChatStreamReader, number>();
// Sized for a parent chat plus a few nested subtask views (or a couple of
// devices) staying live at once, not just one in-flight navigation handoff.
const MAX_CONCURRENT_STREAMS = 6;
export class ChatStreams {
  readonly #items = new Map<string, Subscription>();
  constructor(readonly reader: ChatStreamReader,
    readonly send: (update: ChatStreamUpdate, signal: AbortSignal) => Promise<boolean>,
    readonly closed: (target: ChatStreamTarget) => Promise<void> = async () => {}) {}

  async subscribe(target: ChatStreamTarget): Promise<ChatStreamUpdate> {
    let item = this.#items.get(target.subscriptionId);
    if (item && JSON.stringify(item.target) !== JSON.stringify(target)) throw new ChatAccessError("access_denied");
    if (!item) {
      if (this.#items.size >= MAX_CONCURRENT_STREAMS || (readers.get(this.reader) ?? 0) >= MAX_CONCURRENT_STREAMS ||
          (watchers.get(this.reader) ?? 0) >= MAX_CONCURRENT_STREAMS) throw new ChatAccessError("context_expired");
      item = { target, controller: new AbortController(), revision: -1, dirty: false, reset: false, pending: true };
      this.#items.set(target.subscriptionId, item);
      const current = item;
      let ready: () => void = () => {};
      current.ready = new Promise((resolve) => { ready = resolve; });
      current.expiry = setTimeout(() => { this.#remove(current, true); }, 10_000);
      current.expiry.unref();
      // Start listening before the baseline read. Events arriving during a read
      // set one dirty bit; there is never a queue of token events or snapshots.
      watchers.set(this.reader, (watchers.get(this.reader) ?? 0) + 1);
      void Promise.resolve().then(() => this.reader.watchChat(target, current.controller.signal, (reset) => {
        if (current.controller.signal.aborted) return;
        ready();
        current.dirty = true;
        current.reset ||= reset;
        this.#schedule(current);
      })).then(() => {
        if (!current.controller.signal.aborted) this.#remove(current, true);
      }).catch(() => { this.#remove(current, true); })
        .finally(() => watchers.set(this.reader, (watchers.get(this.reader) ?? 1) - 1));
      item.pending = false;
    }
    if (item.pending) {
      if (!item.snapshot) throw new ChatAccessError("context_expired");
      // A live read/send already owns the serialization slot. Renew the lease
      // using its last authorized baseline instead of queuing overlapping work.
      this.#lease(item);
      return this.#update(item, item.snapshot, false);
    }
    item.pending = true;
    clearTimeout(item.timer);
    delete item.timer;
    try {
      let abort: () => void = () => {};
      try {
        await Promise.race([item.ready, new Promise<never>((_, reject) => {
          abort = () => { reject(new ChatAccessError("context_expired")); };
          item.controller.signal.addEventListener("abort", abort, { once: true });
          if (item.controller.signal.aborted) abort();
        })]);
      } finally { item.controller.signal.removeEventListener("abort", abort); }
      const reset = item.reset;
      item.dirty = item.reset = false;
      const snapshot = await this.#read(item, true);
      item.snapshot = snapshot;
      this.#lease(item);
      return this.#update(item, snapshot, reset);
    } catch (error) {
      this.#remove(item);
      throw error;
    } finally {
      item.pending = false;
      this.#schedule(item);
    }
  }

  #lease(item: Subscription) {
    clearTimeout(item.expiry);
    item.expiry = setTimeout(() => { this.#remove(item, true); }, 60_000);
    item.expiry.unref();
  }

  unsubscribe(target: ChatStreamTarget): { version: 1; unsubscribed: true } {
    const item = this.#items.get(target.subscriptionId);
    if (item && (item.target.projectId !== target.projectId || item.target.sessionId !== target.sessionId ||
      item.target.parentSessionId !== target.parentSessionId)) throw new ChatAccessError("access_denied");
    if (item) this.#remove(item);
    return { version: 1, unsubscribed: true };
  }
  dispose(): void { for (const item of this.#items.values()) this.#remove(item); }
  #remove(item: Subscription, notify = false) {
    const current = this.#items.get(item.target.subscriptionId) === item;
    if (current) this.#items.delete(item.target.subscriptionId);
    clearTimeout(item.timer);
    clearTimeout(item.expiry);
    delete item.snapshot;
    item.controller.abort();
    if (current && notify) void this.closed(item.target).catch(() => {});
  }
  async #read(item: Subscription, reconcile = false): Promise<Snapshot> {
    const count = readers.get(this.reader) ?? 0;
    if (count >= MAX_CONCURRENT_STREAMS) throw new ChatAccessError("context_expired");
    readers.set(this.reader, count + 1);
    const signal = AbortSignal.any([item.controller.signal, AbortSignal.timeout(10_000)]);
    let abort: () => void = () => {};
    try {
      const read = Promise.resolve().then(() => this.reader.readChat(item.target, signal, reconcile))
        .finally(() => readers.set(this.reader, (readers.get(this.reader) ?? 1) - 1));
      const value = await Promise.race([read, new Promise<never>((_, reject) => {
        abort = () => { reject(new ChatAccessError("context_expired")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
      signal.throwIfAborted();
      const snapshot = chatResponses["chat.snapshot"].parse(value);
      if (snapshot.chat.id !== item.target.sessionId || snapshot.chat.parentId !== item.target.parentSessionId) {
        throw new ChatAccessError("access_denied");
      }
      return snapshot;
    } finally { signal.removeEventListener("abort", abort); }
  }
  #update(item: Subscription, snapshot: Snapshot, reset: boolean): ChatStreamUpdate {
    const { version, projectId, sessionId, parentSessionId, subscriptionId } = item.target;
    const revision = ++item.revision;
    if (reset) item.resetRevision = revision;
    return chatStreamUpdateSchema.parse({ version, projectId, sessionId, ...(parentSessionId ? { parentSessionId } : {}), subscriptionId,
      revision, reset, ...(item.resetRevision !== undefined ? { resetRevision: item.resetRevision } : {}), snapshot });
  }
  #schedule(item: Subscription) {
    if (!item.dirty || item.pending || item.timer || item.controller.signal.aborted || !item.snapshot) return;
    item.timer = setTimeout(() => {
      delete item.timer;
      item.pending = true;
      const reset = item.reset;
      item.dirty = item.reset = false;
      void (async () => {
        try {
          const next = await this.#read(item);
          // #schedule only reaches this callback when item.snapshot was already set;
          // the narrowing doesn't survive into this closure or across the await above.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const previous = item.snapshot!;
          const messages = reset ? next.messages : next.messages.filter((message) =>
            JSON.stringify(message) !== JSON.stringify(previous.messages.find((old) => old.id === message.id)));
          item.snapshot = next;
          if (!reset && !messages.length && next.status === previous.status &&
            JSON.stringify(next.chat) === JSON.stringify(previous.chat) &&
            // A task ticking over to completed can be the only change in a batch.
            JSON.stringify(next.todos) === JSON.stringify(previous.todos)) return;
          if (!await this.send(this.#update(item, { ...next, messages }, reset), item.controller.signal)) this.#remove(item);
        } catch { this.#remove(item, true); }
        finally { item.pending = false; this.#schedule(item); }
      })();
    }, 100);
    item.timer.unref();
  }
}
