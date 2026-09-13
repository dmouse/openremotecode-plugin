import { createHash } from "node:crypto"
import type { Activity, ChatMessagePart } from "@openremotecode/protocol"

interface Block { id: string; kind: "text" | "reasoning"; text: string; state: Activity["state"];
  start?: number; end?: number; incomplete: boolean }
interface Message { blocks: Map<string, Block>; running: boolean; terminal: boolean }
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128
const clock = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
export const nextPartId = (messageId: string, kind: string, sourceId: string) =>
  `live_${createHash("sha256").update(JSON.stringify([messageId, JSON.stringify([kind, sourceId])])).digest("base64url")}`

/** Native next-engine events are not legacy PartDelta events. Keep their
 * provider-local IDs scoped to the assistant message, with no provider metadata. */
export class NextActivity {
  readonly messages = new Map<string, Message>()
  readonly #seen = new Set<string>()
  status: "busy" | "idle" | undefined
  constructor(readonly sessionId: string) {}

  capture(type: string, p: Record<string, unknown>, eventId: unknown): boolean {
    if (p.sessionID !== this.sessionId || !type.startsWith("session.next.")) return false
    const match = /^session\.next\.(reasoning|text)\.(started|delta|ended)$/u.exec(type)
    const step = /^session\.next\.step\.(started|ended|failed)$/u.exec(type)
    if (!match && !step) return false
    if (!id(p.assistantMessageID)) return false
    if (match && (!id(p[match[1] === "text" ? "textID" : "reasoningID"]) ||
      (match[2] === "delta" && typeof p.delta !== "string") ||
      (match[2] === "ended" && typeof p.text !== "string"))) return false
    if (id(eventId)) {
      if (this.#seen.has(eventId)) return true
      if (this.#seen.size >= 2048) {
        const oldest = this.#seen.values().next().value
        if (oldest !== undefined) this.#seen.delete(oldest)
      }
      this.#seen.add(eventId)
    }
    let message = this.messages.get(p.assistantMessageID)
    if (!message) {
      if (this.messages.size >= 10) {
        const oldest = [...this.messages].find(([, m]) => !m.running)
        if (!oldest) throw new Error("Live next message limit")
        this.messages.delete(oldest[0])
      }
      message = { blocks: new Map(), running: false, terminal: false }
      this.messages.set(p.assistantMessageID, message)
    }
    if (step) {
      if (message.terminal && step[1] === "started") return true
      message.running = step[1] === "started"
      if (message.running) this.status = "busy"
      else {
        message.terminal = true
        const state = step[1] === "failed" ? "failed" : "completed"
        for (const block of message.blocks.values()) if (block.state === "running") {
          block.state = state
          if (clock(p.timestamp) && block.start !== undefined && p.timestamp >= block.start) block.end = p.timestamp
        }
        if (step[1] === "failed" || p.finish === "stop" || p.finish === "end_turn") this.status = "idle"
      }
      return true
    }
    // Provably non-null: line 24 returns unless match or step is set, and the
    // `if (step)` block above always returns, so step is now falsy and match must be set.
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    const kind = match![1] as Block["kind"]
    const phase = match![2]!
    /* eslint-enable @typescript-eslint/no-non-null-assertion */
    if (message.terminal && phase !== "ended") return true
    const key = JSON.stringify([kind, p[kind === "text" ? "textID" : "reasoningID"]])
    let block = message.blocks.get(key)
    if (!block) {
      if (message.blocks.size >= 100) throw new Error("Live next part limit")
      block = { id: nextPartId(p.assistantMessageID, kind, p[kind === "text" ? "textID" : "reasoningID"] as string),
        kind, text: "", state: "running", incomplete: phase === "delta" }
      message.blocks.set(key, block)
    }
    if (phase === "started") {
      if (clock(p.timestamp) && block.start === undefined) block.start = p.timestamp
      // Duplicate starts never erase received text or reopen a finished block.
    } else if (phase === "delta" && block.state === "running") {
      block.text += (p.delta as string).slice(0, Math.max(0, 48001 - block.text.length))
    } else if (phase === "ended") {
      block.text = (p.text as string).slice(0, 48001)
      block.state = "completed"
      block.incomplete = false
      if (clock(p.timestamp) && block.start !== undefined && p.timestamp >= block.start) block.end = p.timestamp
    }
    if (block.state === "running") { message.running = true; this.status = "busy" }
    let size = 0
    for (const message of this.messages.values()) for (const block of message.blocks.values()) size += block.text.length
    if (size > 480000) throw new Error("Live next text limit")
    return true
  }

  parts(messageId: string): ChatMessagePart[] {
    return [...(this.messages.get(messageId)?.blocks.values() ?? [])].map((b) => b.kind === "text"
      ? { id: b.id, type: "text", text: b.text + "\n" }
      : { id: b.id, type: "reasoning", text: b.text, activity: { kind: "reasoning", state: b.state },
        ...(b.start !== undefined ? { time: { start: b.start, ...(b.end !== undefined ? { end: b.end } : {}) } } : {}) })
  }
  incomplete(messageId: string): boolean {
    return [...(this.messages.get(messageId)?.blocks.values() ?? [])].some((b) => b.incomplete)
  }
  remove(messageId: string): void { this.messages.delete(messageId) }
  clear(): void { this.messages.clear(); this.#seen.clear(); this.status = undefined }
}
