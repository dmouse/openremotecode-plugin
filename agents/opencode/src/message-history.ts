import type { PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { z } from "zod";
import { nextPartId } from "./next-activity.js";

export interface HistoryMessage { info: { id: string; sessionID: string; role: "user" | "assistant"; time?: { created?: number; completed?: number };
  modelID?: string; providerID?: string; variant?: string; agent?: string; mode?: string }; parts: Part[] }
const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative();
const nextMessage = z.object({ id, type: z.enum(["user", "assistant", "shell", "synthetic", "system", "compaction", "agent-switched", "model-switched"]),
  time: z.object({ created: time, completed: time.optional() }) }).loose();
const nextPage = z.object({ data: z.array(nextMessage).max(10), cursor: z.object({ next: z.string().max(16000).nullish() }).loose() });
const position = z.object({ cursor: z.string().max(16000).optional(), pending: z.array(id).max(10).default([]), done: z.boolean().default(false) });
const paging = z.object({ legacy: position, next: position });
const prefix = "history-v2:";

function convert(message: z.infer<typeof nextMessage>, sessionID: string): HistoryMessage {
  // Copy presentation fields only. Provider metadata, tool structures and file
  // contents never become public parts. Existing projection enforces opt-ins.
  const m = message as Record<string, any>;
  if (m.sessionID !== undefined && m.sessionID !== sessionID) throw new Error("Invalid message membership");
  const base = { sessionID, messageID: m.id };
  const part = (kind: string, source: string) => ({ ...base, id: nextPartId(m.id, kind, id.parse(source)) });
  const parts: Part[] = [];
  const text = (value: unknown) => z.string().parse(value).slice(0, 48001);
  if (m.type === "user") {
    parts.push({ ...part("text", "prompt"), type: "text", text: text(m.text) });
    if (Array.isArray(m.files)) {for (const [index, file] of m.files.slice(0, 100).entries()) {
      // v2 attaches a file as {data: base64, mime, source: {type:"inline"|"uri", ...}}, not v1's
      // single data: URI. A "uri"-sourced attachment has no inline bytes here at all, so `data`
      // is naturally empty for one and this degrades to the existing label-only path, the same
      // as any other non-image or oversized file already does.
      const mime: string = typeof file.mime === "string" ? file.mime : "application/octet-stream";
      const data: string = typeof file.data === "string" ? file.data : "";
      parts.push({ ...part("file", String(index)), type: "file", filename: typeof file.name === "string" ? file.name : "File",
        mime, url: data ? `data:${mime};base64,${data}` : "" });
    }}
  } else if (m.type === "assistant") {
    if (!Array.isArray(m.content)) throw new Error("Invalid next content");
    // OpenCode 2.0 no longer gives text and reasoning content an id of their own; position within
    // the message is then the only stable identity, and the id is kept whenever one exists.
    for (const [index, content] of m.content.slice(0, 100).entries()) {
      if (content.type === "text") parts.push({ ...part("text", content.id ?? String(index)), type: "text", text: text(content.text) });
      else if (content.type === "reasoning") {
        const clock = content.time;
        parts.push({ ...part("reasoning", content.id ?? String(index)), type: "reasoning", text: text(content.text),
          ...(clock && time.safeParse(clock.created).success ? { time: { start: clock.created,
            ...(time.safeParse(clock.completed).success && clock.completed >= clock.created ? { end: clock.completed } : {}) } } : {}) } as Part);
      } else if (content.type === "tool") {
        const state = content.state;
        // OpenCode 2.0 adds a "streaming" status (partial, not-yet-parsed input) that the pinned
        // v1 status enum has no slot for; it is not yet a call the model has committed to, so it
        // reads the same as "running" -- never thrown on, and never confused with "pending"
        // (which native v2 tool state does not use at all).
        const status = z.enum(["pending", "running", "completed", "error"]).parse(state?.status === "streaming" ? "running" : state?.status);
        const input = state.input && typeof state.input === "object" && !Array.isArray(state.input) ? state.input : {};
        const rawMetadata = state.metadata && typeof state.metadata === "object" && !Array.isArray(state.metadata) ? state.metadata : {};
        // Only a completed/error state's own `content` is real transcript text; a running/streaming
        // state has none yet. Deriving `output` only where real content exists, and otherwise
        // keeping whatever `metadata.output` OpenCode itself already published (if anything),
        // means a native `truncated` flag or an in-progress shell's own live output survive
        // instead of being silently replaced by a synthesized empty one.
        const derived = Array.isArray(state.content) ? state.content.filter((p: any) => p.type === "text" && typeof p.text === "string")
          .slice(0, 100).map((p: any) => p.text.slice(0, 48001)).join("\n").slice(0, 48001) : undefined;
        const output = derived ?? (typeof rawMetadata.output === "string" ? rawMetadata.output : "");
        parts.push({ ...part("tool", content.id), type: "tool", tool: z.string().max(256).parse(content.name), callID: content.id,
          state: { status, input, output, error: typeof state.error?.message === "string" ? state.error.message : "",
            metadata: { ...rawMetadata, ...(derived !== undefined ? { output: derived } : {}) },
            time: { start: content.time?.ran ?? content.time?.created, end: content.time?.completed }, title: "" } } as Part);
      } else throw new Error("Unsupported next content");
    }
    if (m.content.length > 100) parts.push({ ...part("text", "limit"), type: "text", text: "" });
  } else if (m.type === "shell") {
    parts.push({ ...part("tool", m.callID), type: "tool", tool: "bash", callID: m.callID,
      state: { status: m.time.completed === undefined ? "running" : "completed", input: { command: text(m.command) },
        output: text(m.output), metadata: { output: text(m.output) }, time: { start: m.time.created, end: m.time.completed }, title: "" } } as Part);
  }
  // The next engine references the model by a ModelRef ({ id, providerID,
  // variant? }, `id` being the model id -- not to be confused with the
  // message's own `id`) instead of the legacy engine's flat modelID/
  // providerID/variant fields. Normalize both to the same flat shape here so
  // callers (chat-adapter's model recovery) don't need to know which engine
  // a message came from. See CHAT-MODEL.md.
  const model = m.type === "assistant" && m.model && typeof m.model === "object" ? m.model : undefined;
  const modelID = typeof model?.id === "string" ? model.id : undefined;
  const providerID = typeof model?.providerID === "string" ? model.providerID : undefined;
  const variant = typeof model?.variant === "string" ? model.variant : undefined;
  // The agent a message was generated under -- "build"/"plan"/a custom name.
  // The next engine names this the same as the legacy engine's UserMessage.agent
  // and AssistantMessage.mode: user carries it as `agent`, assistant as `mode`.
  const agent = m.type === "user" && typeof m.agent === "string" ? m.agent : undefined;
  // OpenCode 2.0 names an assistant message's agent `agent`; earlier next-engine builds named it `mode`.
  const mode = m.type === "assistant" ? typeof m.mode === "string" ? m.mode : typeof m.agent === "string" ? m.agent : undefined
    : undefined;
  return { info: { id: m.id, sessionID, role: m.type === "user" ? "user" : "assistant", time: m.time,
    ...(modelID !== undefined ? { modelID } : {}), ...(providerID !== undefined ? { providerID } : {}),
    ...(variant !== undefined ? { variant } : {}), ...(agent !== undefined ? { agent } : {}),
    ...(mode !== undefined ? { mode } : {}) }, parts };
}

/** One message from OpenCode 2's message list, projected for the shared chat presentation layer.
 * Only user and assistant messages are chat content; other kinds (agent, model or location
 * switches, system, skill, compaction, idle) are the caller's to skip before parsing. */
export function convertNextMessage(raw: unknown, sessionID: string): HistoryMessage {
  return convert(nextMessage.parse(raw), sessionID);
}

/** Merge both native stores with bounded pages. Opaque cursors retain only
 * native cursors and unconsumed message IDs, never conversation content. Pending
 * IDs anchor a partial page even if new messages arrive before the next read. */
export async function readMessageHistory(client: PluginInput["client"], directory: string, sessionID: string,
  before: string | undefined, signal: AbortSignal): Promise<{ messages: HistoryMessage[]; cursor: string | null }> {
  const state = before?.startsWith(prefix) ? paging.parse(JSON.parse(before.slice(prefix.length)))
    : paging.parse({ legacy: before ? { cursor: before } : {}, next: before ? { done: true } : {} });
  const pages = await Promise.all((["legacy", "next"] as const).map(async (source) => {
    const p = state[source];
    if (p.pending.length) {
      const items: HistoryMessage[] = [];
      for (const messageID of p.pending) {
        const options = { path: { id: sessionID, messageID }, query: { directory }, signal,
          ...(source === "next" ? { url: "/api/session/{id}/message/{messageID}" } : {}) };
        const result = await client.session.message(options);
        if (result.response.status === 404) continue;
        if (!result.response.ok) throw new Error("Invalid message page");
        const value = source === "next" ? convert(nextMessage.parse((result.data as any)?.data), sessionID) : result.data as HistoryMessage;
        if (value.info.id !== messageID || value.info.sessionID !== sessionID) throw new Error("Invalid message membership");
        items.push(value);
      }
      return { source, items, cursor: p.cursor };
    }
    if (p.done) return { source, items: [] as HistoryMessage[], cursor: undefined };
    const options = { path: { id: sessionID }, signal,
      ...(source === "next" ? { url: "/api/session/{id}/message" } : {}),
      query: { directory, limit: 10, ...(source === "next" ? p.cursor ? { cursor: p.cursor } : { order: "desc" }
        : p.cursor ? { before: p.cursor } : {}) } };
    const result = await client.session.messages(options);
    if (source === "legacy") {
      if (!result.response.ok || !Array.isArray(result.data) || result.data.length > 10 ||
        result.data.some((m) => m.info.sessionID !== sessionID)) throw new Error("Invalid legacy history");
      return { source, items: [...result.data].reverse(), cursor: result.response.headers.get("x-next-cursor") ?? undefined };
    }
    if (result.response.status === 404) return { source, items: [] as HistoryMessage[], cursor: undefined };
    if (!result.response.ok) throw new Error("Invalid next history");
    const page = nextPage.parse(result.data);
    return { source, items: page.data.map((m) => convert(m, sessionID)), cursor: page.cursor.next ?? undefined };
  }));
  const candidates = pages.flatMap((p) => p.items.map((m) => ({ ...m, source: p.source })))
    .sort((a, b) => (b.info.time?.created ?? 0) - (a.info.time?.created ?? 0) || b.info.id.localeCompare(a.info.id) || b.source.localeCompare(a.source));
  const chosen = new Map<string, HistoryMessage>();
  for (const message of candidates) {
    if (chosen.size === 10 && !chosen.has(message.info.id)) break;
    if (!chosen.has(message.info.id)) chosen.set(message.info.id, message);
  }
  for (const page of pages) {
    const p = state[page.source];
    p.pending = page.items.filter((m) => !chosen.has(m.info.id)).map((m) => m.info.id);
    if (page.cursor) p.cursor = page.cursor;
    else { delete p.cursor; p.done = true; }
  }
  return { messages: [...chosen.values()].reverse(), cursor: state.legacy.done && state.next.done &&
    !state.legacy.pending.length && !state.next.pending.length ? null : prefix + JSON.stringify(state) };
}
