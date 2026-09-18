import type { FilePart, Part, ToolPart } from "@opencode-ai/sdk";
import type { ChatImage, ChatMessagePart, ChatPermission, ChatQuestion, ChatSubtask, ChatTodo, ChatTool } from "@openremotecode/protocol";
import { IMAGE_DATA_MAX } from "@openremotecode/protocol";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import sharp from "sharp";
import { activityFor } from "./activity-adapter.js";

// Rebudget normalized live replacements together with retained tool/shell/image parts.
// The public concatenation invariant and per-message limits apply on every event.
export function boundedMessageParts(input: ChatMessagePart[], shortened = false) {
  const parts: ChatMessagePart[] = [];
  let remaining = 48000;
  for (const source of input) {
    if (parts.length === 100 || remaining === 0) { shortened = true; break; }
    if (source.type === "image") {
      // Base64 image data cannot be meaningfully truncated; it either fits
      // whole or is dropped, unlike text/shell fields sliced below.
      if (source.image.data.length > remaining) { shortened = true; continue; }
      remaining -= source.image.data.length;
      parts.push(source);
      continue;
    }
    const part = { ...source, text: source.text.slice(0, remaining) };
    shortened ||= part.text.length < source.text.length;
    remaining -= part.text.length;
    if (part.type === "tool" && part.tool.shell) {
      const shell = part.tool.shell;
      const command = shell.command.slice(0, remaining);
      remaining -= command.length;
      const output = shell.output.slice(0, remaining);
      remaining -= output.length;
      const truncated = shell.truncated || command.length < shell.command.length || output.length < shell.output.length;
      shortened ||= truncated;
      part.tool = { ...part.tool, shell: { command, output, truncated } };
    }
    parts.push(part);
  }
  return { parts, text: parts.filter((p) => p.type !== "reasoning" && p.type !== "image").map((p) => p.text).join(""),
    truncated: shortened };
}

// Bounded input before any decode: worst-case memory for the base64 string
// itself, independent of the further libvips pixel-count guard below.
const IMAGE_MAX_INPUT_BASE64 = 20_000_000;
const IMAGE_URL_PATTERN = /^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]+=*)$/;
// Long-edge/quality steps tried largest first, stopping at the first result
// that fits the shared IMAGE_DATA_MAX budget. Never the original file.
const IMAGE_RESIZE_LADDER: readonly (readonly [number, number])[] = [[720, 70], [480, 60], [320, 45]];
const IMAGE_MAX_PIXELS = 8000 * 8000;

// Decode/resize/re-encode only bytes already inline on the part (never a
// fetched path or URL) into a small JPEG preview. Re-encoding from decoded
// pixels also strips all embedded metadata (EXIF, GPS, ICC, ...). Any
// rejection or failure returns undefined so the caller falls back to today's
// label/exclusion behavior instead of forwarding anything wider.
async function imageAttachment(part: FilePart): Promise<ChatImage | undefined> {
  const match = IMAGE_URL_PATTERN.exec(part.url);
  // Both capture groups are mandatory in IMAGE_URL_PATTERN, so a successful
  // match always populates them; noUncheckedIndexedAccess can't know that.
  if (part.mime !== match?.[1] ||
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    match[2]!.length > IMAGE_MAX_INPUT_BASE64) return undefined;
  let input: Buffer;
  try {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    input = Buffer.from(match[2]!, "base64");
  } catch {
    return undefined;
  }
  try {
    for (const [edge, quality] of IMAGE_RESIZE_LADDER) {
      const { data, info } = await sharp(input, { limitInputPixels: IMAGE_MAX_PIXELS, failOn: "none" })
        .rotate() // apply EXIF orientation before it is discarded below
        .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const encoded = data.toString("base64");
      if (encoded.length <= IMAGE_DATA_MAX) {
        return { mime: "image/jpeg", data: encoded, width: info.width, height: info.height };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Resolves every eligible image FilePart in one message's native parts. Only
// ever awaited from the full snapshot path in chat-adapter.ts — never from
// the synchronous live streaming overlay, which must not block on decode/
// encode work. Callers gate this behind the negotiated includeImages opt-in.
export async function resolveImages(nativeParts: Part[]): Promise<Map<string, ChatImage>> {
  const images = new Map<string, ChatImage>();
  for (const part of nativeParts) {
    if (images.size >= 100 || part.type !== "file") continue;
    const image = await imageAttachment(part);
    if (image) images.set(part.id, image);
  }
  return images;
}

const displayText = (value: unknown, limit = 256) => typeof value === "string"
  // eslint-disable-next-line no-control-regex -- deliberately strips C0/C1 control and bidi-override characters
  ? value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, " ").trim().slice(0, limit) : "";

function displayPath(value: unknown, directory?: string) {
  if (typeof value !== "string" || !value || value.length > 4096) return "";
  const relative = directory && path.isAbsolute(value) ? path.relative(directory, value) : path.normalize(value);
  return displayText(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    ? path.basename(value) : relative || ".");
}

// Shared with permissionSummary below: OpenCode's native tool/permission
// type names collapse to this fixed presentation set; anything unrecognized
// falls back to "tool", never a native name copied through verbatim.
const toolOperations: Record<string, ChatTool["operation"]> = { read: "read", edit: "edit", write: "write",
  grep: "search", glob: "search", list: "list", bash: "execute", webfetch: "fetch", question: "question" };

// The pinned 1.18.30 binary's actual "permission.asked" event payload --
// confirmed via `strings` on the binary and live event capture. It does not
// match the SDK's generated `Permission` type (no `title`/`type`/`pattern`);
// it carries the permission kind as a bare string and patterns as an array.
export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
}

// OpenCode itself never prepares a display string for this event (unlike
// the SDK's documented but unpopulated `Permission.title`) -- only the bare
// kind. This mirrors the phrasing OpenCode's own TUI builds for the same kinds.
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  external_directory: "Access an external directory", bash: "Run a shell command", edit: "Edit a file",
  write: "Write a file", read: "Read a file", grep: "Search file contents", glob: "Search for files",
  list: "List a directory", webfetch: "Fetch a URL", doom_loop: "Continue after repeated failures",
};

// Object.hasOwn (not `?? fallback`): part.tool is attacker-influenced and a
// bracket lookup of "__proto__"/"constructor" must not resolve off-object.
// The `?.`/`!` below guard fields the SDK's types declare non-optional but
// native tool/reasoning state can omit in practice.
/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-non-null-assertion */
function toolSummary(part: ToolPart, directory?: string, answeredQuestions: readonly AnsweredQuestionBatch[] = []): ChatTool {
  const operation = Object.hasOwn(toolOperations, part.tool) ? toolOperations[part.tool]! : "tool";
  let description = "";
  // Never forward arbitrary tool input, command strings, URLs, outputs or errors.
  // Native tool state can omit `input` despite the SDK's non-optional type.
  if (["read", "edit", "write"].includes(operation)) {
    description = displayPath(part.state.input?.filePath, directory);
  } else if (operation === "search") {
    const pattern = displayText(part.state.input?.pattern).slice(0, 160);
    const location = displayPath(part.state.input?.path, directory).slice(0, 80);
    description = [pattern ? `"${pattern}"` : "", location ? `in ${location}` : ""].filter(Boolean).join(" ");
  } else if (part.tool === "bash") description = displayText(part.state.input?.description);
  else if (operation === "question") {
    // The tool's own declared input schema, already trusted and sanitized the same way
    // the live pending banner is (see ADR 0011) -- never the tool's native output/metadata.
    const questions = sanitizeQuestionPrompts(part.state.input?.questions);
    if (questions) {
      // Matched by sanitized content, not a native id: this pinned event payload carries
      // none. See ADR 0011, "Update: a persisted asked/answered record".
      const matched = answeredQuestions.find((batch) =>
        JSON.stringify(batch.questions) === JSON.stringify(questions));
      const label = (entry: NonNullable<typeof questions>[number]) => entry.header || entry.question.slice(0, 40);
      // Re-sanitized here even though every fragment was already sanitized once: a
      // free-text answer is forwarded as the user typed it (see ADR 0011's "Update:
      // free-text answers") and has never itself passed through control-char/bidi
      // stripping, unlike a question, header, or option label.
      description = displayText(matched
        ? questions.map((entry, index) => `${label(entry)}: ${matched.answers[index] ?? ""}`).join(" · ")
        : questions.map((entry) => label(entry)).join(", "));
    }
  } else if (operation === "tool") {
    // Fixed summaries for known MCP/UI actions, never their arguments or outputs.
    const actions: Record<string, string> = {
      "mobile-mcp_mobile_list_available_devices": "List connected devices",
      "mobile-mcp_mobile_list_elements_on_screen": "Inspect screen elements",
      "mobile-mcp_mobile_take_screenshot": "Capture screen",
      "mobile-mcp_mobile_save_screenshot": "Save screenshot",
      "mobile-mcp_mobile_click_on_screen_at_coordinates": "Tap screen",
      "mobile-mcp_mobile_long_press_on_screen_at_coordinates": "Long-press screen",
      "mobile-mcp_mobile_swipe_on_screen": "Swipe screen",
      "mobile-mcp_mobile_launch_app": "Open app",
      "mobile-mcp_mobile_install_app": "Install app",
      "mobile-mcp_mobile_press_button": "Press device button",
      "mobile-mcp_mobile_type_keys": "Enter text",
      "context7_query-docs": "Look up documentation",
      "context7_resolve-library-id": "Find library documentation",
      apply_patch: "Apply patch", todowrite: "Update task list", skill: "Load skill", task: "Run subtask",
    };
    const name = displayText(part.tool).replace(/[_-]+/gu, " ").trim();
    description = displayText(Object.hasOwn(actions, part.tool) ? actions[part.tool]!
      : name ? name.charAt(0).toUpperCase() + name.slice(1) : "");
  }
  const status = ["pending", "running", "completed", "error"].includes(part.state.status)
    ? part.state.status : "unknown";
  const time = part.state.status === "completed" || part.state.status === "error" ? part.state.time : undefined;
  const duration = time && Number.isSafeInteger(time.start) && time.start >= 0 &&
    Number.isSafeInteger(time.end) && time.end >= time.start ? time.end - time.start : undefined;
  return { operation, status, ...(description ? { description } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}) };
}

export function subtaskSummary(part: ToolPart): ChatSubtask {
  const string = (value: unknown, limit: number, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : fallback;
  return { title: string(part.state.input?.description, 512, "Subtask"),
    agent: string(part.state.input?.subagent_type, 64, "general"),
    status: part.state.status,
    background: part.state.status !== "pending" && part.state.metadata?.background === true };
}

// Only a bounded, locally-built description and the request's own patterns
// cross this boundary. The raw metadata and "always"/save fields (a
// persistent grant) are never forwarded. See CHAT-PERMISSIONS.md.
// OpenCode's "question.asked" payload. The question text and option labels are authored
// by the model, so they are the one place agent-written text is deliberately forwarded --
// see ADR 0011. Everything here is sanitized and capped before it leaves the plugin.
export interface QuestionRequest {
  id: string
  sessionID: string
  questions?: { question?: unknown; header?: unknown; multiple?: unknown; custom?: unknown
    options?: { label?: unknown; description?: unknown }[] }[]
}

/**
 * Sanitizes and caps a raw `questions` array to the same bounds everywhere this data
 * crosses the boundary -- the live pending batch (see ADR 0011) and a completed
 * `question` tool part's own `input.questions` (see "Update: a persisted asked/answered
 * record" in ADR 0011) both go through this one function, so both present identically.
 * A malformed entry is dropped rather than presented empty.
 */
function sanitizeQuestionPrompts(raw: unknown): ChatQuestion["questions"] | undefined {
  const source = Array.isArray(raw) ? raw.slice(0, 8) : [];
  const questions = source.map((entry: { question?: unknown; header?: unknown; multiple?: unknown; custom?: unknown
    options?: { label?: unknown; description?: unknown }[] }) => {
    const question = displayText(entry?.question, 2000);
    if (!question) return undefined;
    const options = (Array.isArray(entry?.options) ? entry.options : []).slice(0, 32)
      .map((option) => {
        const label = displayText(option?.label, 80);
        const description = displayText(option?.description, 256);
        return label ? { label, ...(description ? { description } : {}) } : undefined;
      })
      .filter((option): option is { label: string; description?: string } => option !== undefined);
    if (!options.length) return undefined;
    // OpenCode's own default: a question offers a free-text "type your own answer" unless it
    // explicitly opts out. See ADR 0011.
    return { header: displayText(entry?.header, 64), question, options,
      multiple: entry?.multiple === true, custom: entry?.custom !== false };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return questions.length ? questions : undefined;
}

/**
 * Normalizes the whole pending batch, in OpenCode's own order. OpenCode's `question` tool
 * can ask several at once, all sharing one request id and answered together -- see ADR
 * 0011. Returns undefined when nothing is presentable, so a malformed payload becomes
 * "no question" rather than an empty prompt.
 */
export function questionSummary(request: QuestionRequest): ChatQuestion | undefined {
  if (typeof request.id !== "string" || !request.id || request.id.length > 128) return undefined;
  const questions = sanitizeQuestionPrompts(request.questions);
  return questions ? { id: request.id, questions } : undefined;
}

// A previously answered or rejected question batch, remembered by the plugin itself at
// reply time (never read back from OpenCode's own native tool output/metadata) so a
// completed `question` tool part can show what was asked and chosen. `answers[i]` is a
// plain display string for `questions[i]` -- joined selected labels, the free-text
// answer, or "Declined" for a rejected batch. See ADR 0011.
export interface AnsweredQuestionBatch {
  questions: ChatQuestion["questions"]
  answers: string[]
}

export function permissionSummary(permission: PermissionRequest): ChatPermission {
  const kind = displayText(permission.permission);
  const operation = Object.hasOwn(toolOperations, permission.permission) ? toolOperations[permission.permission]! : "tool";
  const description = (Object.hasOwn(PERMISSION_DESCRIPTIONS, permission.permission)
    ? PERMISSION_DESCRIPTIONS[permission.permission]! : kind ? `Permission requested: ${kind}` : "Permission requested").slice(0, 256);
  const pattern = displayText(Array.isArray(permission.patterns) ? permission.patterns.join(", ") : "");
  return { id: permission.id, operation, description, ...(pattern ? { pattern } : {}) };
  /* eslint-enable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-non-null-assertion */
}

const TODO_STATUSES: readonly ChatTodo["status"][] = ["pending", "in_progress", "completed", "cancelled"];

// OpenCode's own per-session task list, projected through the same
// presentation allowlist every other field here uses: the item's id, its
// sanitized text, and a strict status. The native `priority` -- and any other
// native field -- stays local. OpenCode types `status` as a bare string, so an
// unrecognized value is presented as "pending" rather than forwarded or
// dropping the item. Items keep OpenCode's own order. See CHAT-TODOS.md.
export function todoSummaries(native: unknown): ChatTodo[] {
  if (!Array.isArray(native)) return [];
  const todos: ChatTodo[] = [];
  const seen = new Set<string>();
  for (const [index, value] of (native as unknown[]).entries()) {
    if (todos.length === 100) break;
    if (!value || typeof value !== "object") continue;
    const { id, content, status } = value as Record<string, unknown>;
    const text = displayText(content);
    if (!text) continue;
    // The SDK's generated `Todo` type declares an `id`, but the pinned
    // 1.18.30 binary never sends one: its own storage keys a todo by
    // (session, position), and `GET /session/{id}/todo` returns
    // {content, status, priority} only -- confirmed against a live server.
    // The item's place in the list is therefore its identity here. A future
    // build that does supply an id is preferred over the positional one.
    const key = typeof id === "string" && id && id.length <= 128 ? id : `todo-${String(index)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    todos.push({ id: key, content: text,
      status: TODO_STATUSES.includes(status as ChatTodo["status"]) ? status as ChatTodo["status"] : "pending" });
  }
  return todos;
}

// Only presentation fields cross this boundary. Shell command/output is an
// explicit opt-in exception; other native metadata and tool output stay local.
// Synthetic text includes OpenCode's expanded attachment context, not user prose.
export function chatMessageContent(role: string, nativeParts: Part[], subtasks?: ReadonlyMap<string, ChatSubtask>,
  options: { includeTools?: boolean; includeShell?: boolean; includeActivities?: boolean; messageFinished?: boolean;
    sessionSettled?: boolean; directory?: string; images?: ReadonlyMap<string, ChatImage>;
    answeredQuestions?: readonly AnsweredQuestionBatch[] } = {}) {
  const parts: ChatMessagePart[] = [];
  let remaining = 48000;
  let truncated = false;
  for (const part of nativeParts) {
    if (part.type === "text" && (part.synthetic || part.ignored)) continue;
    if (part.type === "file") {
      // A previously resolved preview is presented for either role. Callers
      // only ever populate `images` from the async snapshot path, gated on
      // the negotiated chat.images opt-in; it is otherwise always absent,
      // which reproduces today's label/exclusion behavior exactly.
      const image = options.images?.get(part.id);
      if (image && parts.length < 100 && remaining >= image.data.length) {
        remaining -= image.data.length;
        parts.push({ id: part.id, type: "image", text: "", image });
        continue;
      }
      if (image) truncated = true; // resolved, but didn't fit this message's remaining budget
      if (role === "user") {
        if (parts.length === 100 || remaining === 0) { truncated = true; break; }
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- displayText() returns "" (never null/undefined) when there's nothing to show; "File" must replace that empty string too
        const label = displayText(path.basename(part.filename || "File")) || "File";
        const source = `[File: ${label}]\n`;
        const text = source.slice(0, remaining);
        remaining -= text.length;
        truncated ||= text.length < source.length;
        parts.push({ id: part.id, type: "text", text });
      }
      continue;
    }
    if (part.type !== "text" && part.type !== "tool" &&
        !(role === "assistant" && part.type === "reasoning")) continue;
    if (parts.length === 100 || remaining === 0) { truncated = true; break; }
    const source = part.type === "tool" ? `[Tool: ${part.tool} · ${part.state.status}]\n`
      : part.type === "text" ? part.text + "\n" : part.text;
    const text = source.slice(0, remaining);
    remaining -= text.length;
    truncated ||= text.length < source.length;
    if (part.type === "reasoning") {
      // Native reasoning parts can omit `time` despite the SDK's non-optional type.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const { start, end } = part.time ?? {};
      const validStart = Number.isSafeInteger(start) && start >= 0;
      const validEnd = end === undefined || (Number.isSafeInteger(end) && end >= start);
      parts.push({ id: part.id, type: "reasoning", text,
        ...(validStart && validEnd ? { time: { start, ...(end !== undefined ? { end } : {}) } } : {}) });
    } else if (subtasks && role === "assistant" && part.type === "tool" && part.tool === "task") {
      parts.push({ id: part.id, type: "subtask", text, task: subtasks.get(part.id) ?? subtaskSummary(part) });
    } else if (options.includeTools && role === "assistant" && part.type === "tool") {
      const tool = toolSummary(part, options.directory, options.answeredQuestions);
      if (options.includeShell && part.tool === "bash") {
        let shortened = part.state.status !== "pending" && part.state.metadata?.truncated === true;
        const bounded = (value: unknown, limit: number) => {
          const source = typeof value === "string" ? value : "";
          // Bound work before stripping terminal controls; never interpret them.
          const budget = Math.min(remaining, limit);
          const plain = stripVTControlCharacters(source.slice(0, budget * 2))
            .replace(/\r\n?/gu, "\n")
            // eslint-disable-next-line no-control-regex -- deliberately strips C0/C1 control and bidi-override characters
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, "");
          const result = plain.slice(0, budget);
          shortened ||= source.length > budget * 2 || plain.length > result.length;
          remaining -= result.length;
          return result;
        };
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- native tool state can omit `input` despite the SDK's non-optional type
        const command = bounded(part.state.input?.command, 8000);
        // Native shell streaming uses metadata.output. Only this specific field
        // is projected, not the metadata object or a referenced output file.
        const output = bounded(part.state.status === "completed" ? part.state.output
          : part.state.status === "running" ? part.state.metadata?.output
          : part.state.status === "error" ? part.state.metadata?.output ?? part.state.error : "", 32000);
        tool.shell = { command, output, truncated: shortened };
        truncated ||= shortened;
      }
      parts.push({ id: part.id, type: "tool", text, tool });
    } else {
      parts.push({ id: part.id, type: "text", text });
    }
  }
  const text = parts.filter((part) => part.type !== "reasoning" && part.type !== "image").map((part) => part.text).join("");
  if (options.includeActivities) {
    for (const part of parts) {
      const native = nativeParts.find((value) => value.id === part.id);
      const activity = native && activityFor(native, options.messageFinished, options.sessionSettled);
      if (activity && part.type !== "text" && part.type !== "image") part.activity = activity;
    }
  }
  return { text, truncated,
    ...(parts.some((part) => part.type !== "text") ? { parts } : {}) };
}
