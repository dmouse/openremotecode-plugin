import { createHash } from "node:crypto";
import { z } from "zod";
import type { Part } from "./message-parts.js";

export interface HistoryMessage { info: { id: string; sessionID: string; role: "user" | "assistant"; time?: { created?: number; completed?: number };
  modelID?: string; providerID?: string; variant?: string; agent?: string; mode?: string }; parts: Part[] }
const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative();
const messageSchema = z.object({ id, type: z.enum(["user", "assistant", "shell", "synthetic", "system", "compaction", "agent-switched", "model-switched"]),
  time: z.object({ created: time, completed: time.optional() }) }).loose();

// OpenCode's content ids are provider-local, so they are scoped to their message and kind.
const partId = (messageId: string, kind: string, sourceId: string) =>
  `live_${createHash("sha256").update(JSON.stringify([messageId, JSON.stringify([kind, sourceId])])).digest("base64url")}`;

function convert(message: z.infer<typeof messageSchema>, sessionID: string): HistoryMessage {
  // Copy presentation fields only. Provider metadata, tool structures and file
  // contents never become public parts. Existing projection enforces opt-ins.
  const m = message as Record<string, any>;
  if (m.sessionID !== undefined && m.sessionID !== sessionID) throw new Error("Invalid message membership");
  const base = { sessionID, messageID: m.id };
  const part = (kind: string, source: string) => ({ ...base, id: partId(m.id, kind, id.parse(source)) });
  const parts: Part[] = [];
  const text = (value: unknown) => z.string().parse(value).slice(0, 48001);
  if (m.type === "user") {
    // A user message without its own text (an attachment-only turn, or a shape this build
    // has never seen) still has files worth showing; it is not a reason to fail the whole
    // history. Same fail-safe-by-omission rule the content loop below uses.
    if (typeof m.text === "string") parts.push({ ...part("text", "prompt"), type: "text", text: text(m.text) });
    if (Array.isArray(m.files)) {for (const [index, file] of m.files.slice(0, 100).entries()) {
      // A file arrives as {data: base64, mime, source: {type:"inline"|"uri", ...}} and is rebuilt
      // into a data: URI. A "uri"-sourced attachment has no inline bytes here at all, so `data`
      // is naturally empty for one and this degrades to the existing label-only path, the same
      // as any other non-image or oversized file already does.
      const mime: string = typeof file.mime === "string" ? file.mime : "application/octet-stream";
      const data: string = typeof file.data === "string" ? file.data : "";
      parts.push({ ...part("file", String(index)), type: "file", filename: typeof file.name === "string" ? file.name : "File",
        mime, url: data ? `data:${mime};base64,${data}` : "" });
    }}
  } else if (m.type === "assistant") {
    if (!Array.isArray(m.content)) throw new Error("Invalid message content");
    // OpenCode does not give text and reasoning content an id of their own; position within
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
        // A "streaming" status (partial, not-yet-parsed input) is not yet a call the model has
        // committed to, so it reads the same as "running" -- never thrown on, and never confused
        // with "pending" (which native tool state does not use at all).
        const parsed = z.enum(["pending", "running", "completed", "error"]).safeParse(state?.status === "streaming" ? "running" : state?.status);
        // A status this build has no slot for is skipped with its call, rather than guessed
        // at: presenting a tool as running or finished when neither is known would be worse
        // than omitting it, and it must not cost the reader the rest of the conversation.
        if (!parsed.success) continue;
        const status = parsed.data;
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
      }
      // A content kind this build has never seen is skipped, not thrown on. OpenCode is a
      // moving target and the message filter above only guards message kinds; without this,
      // one unfamiliar part inside one message makes the entire chat unreadable instead of
      // costing the reader that part alone.
    }
    if (m.content.length > 100) parts.push({ ...part("text", "limit"), type: "text", text: "" });
  } else if (m.type === "shell") {
    parts.push({ ...part("tool", m.callID), type: "tool", tool: "bash", callID: m.callID,
      state: { status: m.time.completed === undefined ? "running" : "completed", input: { command: text(m.command) },
        output: text(m.output), metadata: { output: text(m.output) }, time: { start: m.time.created, end: m.time.completed }, title: "" } } as Part);
  }
  // OpenCode references the model by a ModelRef ({ id, providerID, variant? },
  // `id` being the model id -- not to be confused with the message's own `id`).
  // Flattened here to the modelID/providerID/variant shape the snapshot's model
  // recovery reads. See CHAT-MODEL.md.
  const model = m.type === "assistant" && m.model && typeof m.model === "object" ? m.model : undefined;
  const modelID = typeof model?.id === "string" ? model.id : undefined;
  const providerID = typeof model?.providerID === "string" ? model.providerID : undefined;
  const variant = typeof model?.variant === "string" ? model.variant : undefined;
  // The agent a message was generated under -- "build"/"plan"/a custom name.
  // A user message carries it as `agent`; an assistant message is normalized to `mode`.
  const agent = m.type === "user" && typeof m.agent === "string" ? m.agent : undefined;
  // An assistant message names its agent `agent`; some builds named it `mode`.
  const mode = m.type === "assistant" ? typeof m.mode === "string" ? m.mode : typeof m.agent === "string" ? m.agent : undefined
    : undefined;
  return { info: { id: m.id, sessionID, role: m.type === "user" ? "user" : "assistant", time: m.time,
    ...(modelID !== undefined ? { modelID } : {}), ...(providerID !== undefined ? { providerID } : {}),
    ...(variant !== undefined ? { variant } : {}), ...(agent !== undefined ? { agent } : {}),
    ...(mode !== undefined ? { mode } : {}) }, parts };
}

/** One message from OpenCode's message list, projected for the chat presentation layer.
 * Only user and assistant messages are chat content; other kinds (agent, model or location
 * switches, system, skill, compaction, idle) are the caller's to skip before parsing. */
export function convertMessage(raw: unknown, sessionID: string): HistoryMessage {
  return convert(messageSchema.parse(raw), sessionID);
}
