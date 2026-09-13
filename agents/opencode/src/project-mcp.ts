import { projectMcpSnapshotSchema, type ProjectMcpSnapshot, type ProjectMcpUpdated } from "@openremotecode/protocol"
import { ChatAccessError } from "./chat-adapter.js"

export interface ProjectMcpReader {
  readProjectMcp(projectId: string, signal: AbortSignal): Promise<ProjectMcpSnapshot>
}

export const PROJECT_MCP_LEASE_MS = 60_000
export const PROJECT_MCP_POLL_MS = 3_000
const READ_TIMEOUT_MS = 10_000
const MAX_OUTSTANDING_READS = 4
const outstandingReads = new WeakMap<ProjectMcpReader, number>()

// Deadlines bound waiting, not unabortable I/O. Reservations survive cancellation
// and relay lifetimes until the underlying authorization/SDK read really settles.
export async function readProjectMcp(reader: ProjectMcpReader, projectId: string, signal: AbortSignal): Promise<ProjectMcpSnapshot> {
  signal.throwIfAborted()
  const outstanding = outstandingReads.get(reader) ?? 0
  if (outstanding >= MAX_OUTSTANDING_READS) return { version: 1, projectId, state: "unavailable", servers: [] }
  const controller = new AbortController()
  const deadline = setTimeout(() => { controller.abort(); }, READ_TIMEOUT_MS)
  deadline.unref()
  const combined = AbortSignal.any([signal, controller.signal])
  let onAbort: () => void = () => {}
  outstandingReads.set(reader, outstanding + 1)
  try {
    const read = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return reader.readProjectMcp(projectId, combined)
    }).finally(() => {
      // Set immediately above; only this function's own finally clears an entry.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const remaining = outstandingReads.get(reader)! - 1
      if (remaining === 0) outstandingReads.delete(reader)
      else outstandingReads.set(reader, remaining)
    })
    const result = projectMcpSnapshotSchema.parse(await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        onAbort = () => { reject(new Error("MCP read cancelled")); }
        combined.addEventListener("abort", onAbort, { once: true })
        if (combined.aborted) onAbort()
      }),
    ]))
    combined.throwIfAborted()
    if (result.projectId !== projectId) throw new ChatAccessError("access_denied")
    return result
  } catch (error) {
    if (signal.aborted) throw new ChatAccessError("context_expired")
    if (error instanceof ChatAccessError) throw error
    return { version: 1, projectId, state: "unavailable", servers: [] }
  } finally {
    clearTimeout(deadline)
    combined.removeEventListener("abort", onAbort)
    controller.abort()
  }
}

interface Subscription {
  projectId: string
  subscriptionId: string
  controller: AbortController
  expires?: number
  expiryTimer?: ReturnType<typeof setTimeout>
  pollTimer?: ReturnType<typeof setTimeout>
  snapshot?: ProjectMcpSnapshot
  revision: number
  pending: number
  tail: Promise<unknown>
}

export class ProjectMcpSubscriptions {
  readonly #subscriptions = new Map<string, Subscription>()
  #disposed = false

  constructor(readonly reader: ProjectMcpReader,
    readonly send: (update: ProjectMcpUpdated, signal: AbortSignal) => Promise<boolean>,
    readonly now: () => number = Date.now) {}

  async subscribe(projectId: string, subscriptionId: string): Promise<ProjectMcpUpdated> {
    this.#expire()
    if (this.#disposed) throw new ChatAccessError("context_expired")
    let subscription = this.#subscriptions.get(subscriptionId)
    if (subscription && subscription.projectId !== projectId) throw new ChatAccessError("access_denied")
    if (!subscription) {
      if (this.#subscriptions.size >= 4) throw new ChatAccessError("context_expired")
      subscription = { projectId, subscriptionId, controller: new AbortController(), revision: -1,
        pending: 0, tail: Promise.resolve() }
      this.#subscriptions.set(subscriptionId, subscription)
    }
    const current = subscription
    return this.#serialize(current, async () => {
      clearTimeout(current.pollTimer)
      try {
        const snapshot = await readProjectMcp(this.reader, projectId, current.controller.signal)
        this.#check(current)
        current.snapshot = snapshot
        const update = this.#update(current)
        current.expires = this.now() + PROJECT_MCP_LEASE_MS
        clearTimeout(current.expiryTimer)
        current.expiryTimer = setTimeout(() => { this.#remove(current); }, PROJECT_MCP_LEASE_MS)
        current.expiryTimer.unref()
        this.#schedulePoll(current)
        return update
      } catch (error) {
        this.#remove(current)
        throw error
      }
    })
  }

  unsubscribe(projectId: string, subscriptionId: string): { version: 1; unsubscribed: true } {
    this.#expire()
    const current = this.#subscriptions.get(subscriptionId)
    if (current && current.projectId !== projectId) throw new ChatAccessError("access_denied")
    if (current) this.#remove(current)
    return { version: 1, unsubscribed: true }
  }

  dispose(): void {
    this.#disposed = true
    for (const subscription of this.#subscriptions.values()) this.#remove(subscription)
  }

  #expire(): void {
    for (const subscription of this.#subscriptions.values()) {
      if (subscription.expires !== undefined && subscription.expires <= this.now()) this.#remove(subscription)
    }
  }

  #check(subscription: Subscription): void {
    this.#expire()
    if (this.#disposed || this.#subscriptions.get(subscription.subscriptionId) !== subscription) {
      throw new ChatAccessError("context_expired")
    }
  }

  #remove(subscription: Subscription): void {
    if (this.#subscriptions.get(subscription.subscriptionId) === subscription) this.#subscriptions.delete(subscription.subscriptionId)
    subscription.controller.abort()
    clearTimeout(subscription.pollTimer)
    clearTimeout(subscription.expiryTimer)
  }

  #serialize<T>(subscription: Subscription, action: () => Promise<T>): Promise<T> {
    if (subscription.pending >= 8) return Promise.reject(new ChatAccessError("context_expired"))
    subscription.pending++
    const task = subscription.tail.then(() => { this.#check(subscription); return action() })
    subscription.tail = task.catch(() => {}).finally(() => { subscription.pending-- })
    return task
  }

  #update(subscription: Subscription): ProjectMcpUpdated {
    if (subscription.revision >= Number.MAX_SAFE_INTEGER) throw new ChatAccessError("context_expired")
    // #update is only called once the subscription has a baseline snapshot.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return { ...subscription.snapshot!, subscriptionId: subscription.subscriptionId, revision: ++subscription.revision }
  }

  #schedulePoll(subscription: Subscription): void {
    clearTimeout(subscription.pollTimer)
    subscription.pollTimer = setTimeout(() => {
      void this.#serialize(subscription, async () => {
        // A renewal ahead of this queued poll may have scheduled another timer.
        clearTimeout(subscription.pollTimer)
        const snapshot = await readProjectMcp(this.reader, subscription.projectId, subscription.controller.signal)
        this.#check(subscription)
        if (JSON.stringify(snapshot) !== JSON.stringify(subscription.snapshot)) {
          subscription.snapshot = snapshot
          const sent = await this.send(this.#update(subscription), subscription.controller.signal)
          this.#check(subscription)
          if (!sent) { this.dispose(); return }
        }
        this.#schedulePoll(subscription)
      }).catch(() => { this.#remove(subscription); })
    }, PROJECT_MCP_POLL_MS)
    subscription.pollTimer.unref()
  }
}
