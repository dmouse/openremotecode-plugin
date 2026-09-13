import type { PluginInput } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import { z } from "zod"
import { nextPartId } from "./next-activity.js"

interface Message { info: { id: string; sessionID: string; role: "user" | "assistant"; time?: { created?: number; completed?: number };
  modelID?: string; providerID?: string; variant?: string; agent?: string; mode?: string }; parts: Part[] }
const id = z.string().min(1).max(128)
const time = z.number().int().nonnegative()
const nextMessage = z.object({ id, type: z.enum(["user", "assistant", "shell", "synthetic", "system", "compaction", "agent-switched", "model-switched"]),
  time: z.object({ created: time, completed: time.optional() }) }).loose()
const nextPage = z.object({ data: z.array(nextMessage).max(10), cursor: z.object({ next: z.string().max(16000).nullish() }).loose() })
const position = z.object({ cursor: z.string().max(16000).optional(), pending: z.array(id).max(10).default([]), done: z.boolean().default(false) })
const paging = z.object({ legacy: position, next: position })
const prefix = "history-v2:"

function convert(message: z.infer<typeof nextMessage>, sessionID: string): Message {
  // Copy presentation fields only. Provider metadata, tool structures and file
  // contents never become public parts. Existing projection enforces opt-ins.
  const m = message as Record<string, any>
  if (m.sessionID !== undefined && m.sessionID !== sessionID) throw new Error("Invalid message membership")
  const base = { sessionID, messageID: m.id }
  const part = (kind: string, source: string) => ({ ...base, id: nextPartId(m.id, kind, id.parse(source)) })
  const parts: Part[] = []
  const text = (value: unknown) => z.string().parse(value).slice(0, 48001)
  if (m.type === "user") {
    parts.push({ ...part("text", "prompt"), type: "text", text: text(m.text) })
    if (Array.isArray(m.files)) for (const [index, file] of m.files.slice(0, 100).entries()) {
      parts.push({ ...part("file", String(index)), type: "file", filename: typeof file.name === "string" ? file.name : "File",
        mime: "text/plain", url: "" })
    }
  } else if (m.type === "assistant") {
    if (!Array.isArray(m.content)) throw new Error("Invalid next content")
    for (const content of m.content.slice(0, 100)) {
      if (content.type === "text") parts.push({ ...part("text", content.id), type: "text", text: text(content.text) })
      else if (content.type === "reasoning") {
        const clock = content.time
        parts.push({ ...part("reasoning", content.id), type: "reasoning", text: text(content.text),
          ...(clock && time.safeParse(clock.created).success ? { time: { start: clock.created,
            ...(time.safeParse(clock.completed).success && clock.completed >= clock.created ? { end: clock.completed } : {}) } } : {}) } as Part)
      } else if (content.type === "tool") {
        const state = content.state
        const status = z.enum(["pending", "running", "completed", "error"]).parse(state?.status)
        const input = state.input && typeof state.input === "object" && !Array.isArray(state.input) ? state.input : {}
        const output = Array.isArray(state.content) ? state.content.filter((p: any) => p.type === "text" && typeof p.text === "string")
          .slice(0, 100).map((p: any) => p.text.slice(0, 48001)).join("\n").slice(0, 48001) : ""
        parts.push({ ...part("tool", content.id), type: "tool", tool: z.string().max(256).parse(content.name), callID: content.id,
          state: { status, input, output, error: typeof state.error?.message === "string" ? state.error.message : "",
            metadata: { output }, time: { start: content.time?.ran ?? content.time?.created, end: content.time?.completed }, title: "" } } as Part)
      } else throw new Error("Unsupported next content")
    }
    if (m.content.length > 100) parts.push({ ...part("text", "limit"), type: "text", text: "" })
  } else if (m.type === "shell") {
    parts.push({ ...part("tool", m.callID), type: "tool", tool: "bash", callID: m.callID,
      state: { status: m.time.completed === undefined ? "running" : "completed", input: { command: text(m.command) },
        output: text(m.output), metadata: { output: text(m.output) }, time: { start: m.time.created, end: m.time.completed }, title: "" } } as Part)
  }
  // The next engine references the model by a ModelRef ({ id, providerID,
  // variant? }, `id` being the model id -- not to be confused with the
  // message's own `id`) instead of the legacy engine's flat modelID/
  // providerID/variant fields. Normalize both to the same flat shape here so
  // callers (chat-adapter's model recovery) don't need to know which engine
  // a message came from. See CHAT-MODEL.md.
  const model = m.type === "assistant" && m.model && typeof m.model === "object" ? m.model : undefined
  const modelID = typeof model?.id === "string" ? model.id : undefined
  const providerID = typeof model?.providerID === "string" ? model.providerID : undefined
  const variant = typeof model?.variant === "string" ? model.variant : undefined
  // The agent a message was generated under -- "build"/"plan"/a custom name.
  // The next engine names this the same as the legacy engine's UserMessage.agent
  // and AssistantMessage.mode: user carries it as `agent`, assistant as `mode`.
  const agent = m.type === "user" && typeof m.agent === "string" ? m.agent : undefined
  const mode = m.type === "assistant" && typeof m.mode === "string" ? m.mode : undefined
  return { info: { id: m.id, sessionID, role: m.type === "user" ? "user" : "assistant", time: m.time,
    ...(modelID !== undefined ? { modelID } : {}), ...(providerID !== undefined ? { providerID } : {}),
    ...(variant !== undefined ? { variant } : {}), ...(agent !== undefined ? { agent } : {}),
    ...(mode !== undefined ? { mode } : {}) }, parts }
}

/** Merge both native stores with bounded pages. Opaque cursors retain only
 * native cursors and unconsumed message IDs, never conversation content. Pending
 * IDs anchor a partial page even if new messages arrive before the next read. */
export async function readMessageHistory(client: PluginInput["client"], directory: string, sessionID: string,
  before: string | undefined, signal: AbortSignal): Promise<{ messages: Message[]; cursor: string | null }> {
  const state = before?.startsWith(prefix) ? paging.parse(JSON.parse(before.slice(prefix.length)))
    : paging.parse({ legacy: before ? { cursor: before } : {}, next: before ? { done: true } : {} })
  const pages = await Promise.all((["legacy", "next"] as const).map(async (source) => {
    const p = state[source]
    if (p.pending.length) {
      const items: Message[] = []
      for (const messageID of p.pending) {
        const options = { path: { id: sessionID, messageID }, query: { directory }, signal,
          ...(source === "next" ? { url: "/api/session/{id}/message/{messageID}" } : {}) }
        const result = await client.session.message(options)
        if (result.response.status === 404) continue
        if (!result.response.ok) throw new Error("Invalid message page")
        const value = source === "next" ? convert(nextMessage.parse((result.data as any)?.data), sessionID) : result.data as Message
        if (value.info.id !== messageID || value.info.sessionID !== sessionID) throw new Error("Invalid message membership")
        items.push(value)
      }
      return { source, items, cursor: p.cursor }
    }
    if (p.done) return { source, items: [] as Message[], cursor: undefined }
    const options = { path: { id: sessionID }, signal,
      ...(source === "next" ? { url: "/api/session/{id}/message" } : {}),
      query: { directory, limit: 10, ...(source === "next" ? p.cursor ? { cursor: p.cursor } : { order: "desc" }
        : p.cursor ? { before: p.cursor } : {}) } }
    const result = await client.session.messages(options)
    if (source === "legacy") {
      if (!result.response.ok || !Array.isArray(result.data) || result.data.length > 10 ||
        result.data.some((m) => m.info.sessionID !== sessionID)) throw new Error("Invalid legacy history")
      return { source, items: [...result.data].reverse(), cursor: result.response.headers.get("x-next-cursor") ?? undefined }
    }
    if (result.response.status === 404) return { source, items: [] as Message[], cursor: undefined }
    if (!result.response.ok) throw new Error("Invalid next history")
    const page = nextPage.parse(result.data)
    return { source, items: page.data.map((m) => convert(m, sessionID)), cursor: page.cursor.next ?? undefined }
  }))
  const candidates = pages.flatMap((p) => p.items.map((m) => ({ ...m, source: p.source })))
    .sort((a, b) => (b.info.time?.created ?? 0) - (a.info.time?.created ?? 0) || b.info.id.localeCompare(a.info.id) || b.source.localeCompare(a.source))
  const chosen = new Map<string, Message>()
  for (const message of candidates) {
    if (chosen.size === 10 && !chosen.has(message.info.id)) break
    if (!chosen.has(message.info.id)) chosen.set(message.info.id, message)
  }
  for (const page of pages) {
    const p = state[page.source]
    p.pending = page.items.filter((m) => !chosen.has(m.info.id)).map((m) => m.info.id)
    if (page.cursor) p.cursor = page.cursor
    else { delete p.cursor; p.done = true }
  }
  return { messages: [...chosen.values()].reverse(), cursor: state.legacy.done && state.next.done &&
    !state.legacy.pending.length && !state.next.pending.length ? null : prefix + JSON.stringify(state) }
}
