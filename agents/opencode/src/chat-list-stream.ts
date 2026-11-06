import { chatListUpdatedSchema, type ChatListTarget, type ChatListUpdate } from "@openremotecode/protocol";
import { ChatAccessError } from "./chat-adapter.js";

type Change = ChatListUpdate["changes"][number]
export interface ChatListReader {
  watch(projectIds: readonly string[], signal: AbortSignal, changed: (sessionId?: string) => void): Promise<void>
  read(projectIds: readonly string[], sessionIds: readonly string[], signal: AbortSignal): Promise<Change[]>
}
interface Subscription {
  target: ChatListTarget; controller: AbortController; revision: number; ids: Set<string>; reset: boolean;
  busy: boolean; timer?: ReturnType<typeof setTimeout>; expiry?: ReturnType<typeof setTimeout>
}
// Reservations outlive cancellation until the native watcher really ends.
const watchers = new WeakMap<ChatListReader, number>();
const readers = new WeakMap<ChatListReader, number>();

/** One bounded metadata-only list lease per authenticated client. Never reads messages. */
export class ChatListStreams {
  #item: Subscription | undefined;
  constructor(readonly reader: ChatListReader,
    readonly send: (update: ChatListUpdate, signal: AbortSignal) => Promise<boolean>,
    readonly closed: (target: ChatListTarget) => Promise<void>) {}

  subscribe(target: ChatListTarget) {
    let item = this.#item;
    if (item && JSON.stringify(item.target) !== JSON.stringify(target)) throw new ChatAccessError("context_expired");
    if (!item) {
      if ((watchers.get(this.reader) ?? 0) >= 2) throw new ChatAccessError("context_expired");
      item = { target, controller: new AbortController(), revision: 0, ids: new Set(), reset: false, busy: false };
      this.#item = item;
      const current = item;
      watchers.set(this.reader, (watchers.get(this.reader) ?? 0) + 1);
      void (async () => this.reader.watch(target.projectIds, current.controller.signal, (id) => {
        if (current.controller.signal.aborted) return;
        if (!id || current.ids.size >= 50) { current.reset = true; current.ids.clear(); }
        else if (!current.reset) current.ids.add(id);
        this.#schedule(current);
      }))().catch(() => {}).finally(() => {
        watchers.set(this.reader, (watchers.get(this.reader) ?? 1) - 1);
        this.#remove(current, true);
      });
    }
    clearTimeout(item.expiry);
    const current = item;
    item.expiry = setTimeout(() => { this.#remove(current, true); }, 60_000);
    item.expiry.unref();
    return { ...target, revision: item.revision };
  }

  unsubscribe(target: ChatListTarget) {
    const item = this.#item;
    if (item && JSON.stringify(item.target) !== JSON.stringify(target)) throw new ChatAccessError("access_denied");
    if (item) this.#remove(item);
    return { version: 1, unsubscribed: true };
  }
  dispose() { if (this.#item) this.#remove(this.#item); }
  #remove(item: Subscription, notify = false) {
    if (this.#item !== item) return;
    this.#item = undefined;
    item.controller.abort();
    clearTimeout(item.timer);
    clearTimeout(item.expiry);
    item.ids.clear();
    if (notify) void this.closed(item.target).catch(() => {});
  }
  #schedule(item: Subscription) {
    if (item.busy || item.timer || item.controller.signal.aborted || (!item.reset && !item.ids.size)) return;
    item.timer = setTimeout(() => {
      delete item.timer;
      item.busy = true;
      const ids = [...item.ids];
      const reset = item.reset;
      item.ids.clear(); item.reset = false;
      void (async () => {
        const signal = AbortSignal.any([item.controller.signal, AbortSignal.timeout(10_000)]);
        try {
          // Even a reset rechecks every folder's current approval via read([]).
          const count = readers.get(this.reader) ?? 0;
          if (count >= 2) throw new ChatAccessError("context_expired");
          readers.set(this.reader, count + 1);
          const changes = await Promise.resolve().then(() => this.reader.read(item.target.projectIds, reset ? [] : ids, signal))
            .finally(() => readers.set(this.reader, (readers.get(this.reader) ?? 1) - 1));
          signal.throwIfAborted();
          const update = chatListUpdatedSchema.parse({ ...item.target, revision: ++item.revision,
            reset: reset || changes.length > 50, changes: changes.slice(0, 50) });
          if (!await this.send(update, signal)) this.#remove(item);
        } catch { this.#remove(item, true); }
        finally { item.busy = false; this.#schedule(item); }
      })();
    }, 150);
    item.timer.unref();
  }
}
