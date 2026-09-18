import { z } from "zod";
import { activitySchema } from "./activity.js";

export const CHAT_VERSION = 1 as const;
// Base64 preview budget: ~34,000 units decodes to ~25.5KB of re-encoded JPEG.
export const IMAGE_DATA_MAX = 34000;
const id = z.string().min(1).max(128);
const version = { version: z.literal(CHAT_VERSION) };
const project = { ...version, projectId: z.uuid() };
const session = { ...project, sessionId: id };
// A model + optional effort choice. `effort`, when present, must be one of
// that model's own reported effortLevels -- not a fixed enum. See CHAT-MODEL.md.
const promptModel = z.object({ providerID: id, modelID: id, effort: id.optional() }).strict();
// One answer to one pending question: either positions into that question's own option
// list, or -- when that question's own `custom` flag allows it -- free text the user
// typed. See chatQuestionSchema and CHAT-QUESTIONS.md.
const chatQuestionAnswerSchema = z.union([
  z.object({ selected: z.array(z.number().int().nonnegative().max(31)).min(1).max(32) }).strict(),
  z.object({ text: z.string().trim().min(1).max(2000) }).strict(),
]);
export type ChatQuestionAnswer = z.infer<typeof chatQuestionAnswerSchema>
export const chatRequests = {
  "project.list": z.object(version).strict(),
  "project.open": z.object({ ...version, path: z.string().min(1).max(4096) }).strict(),
  "chat.list": z.object({ ...project, cursor: z.uuid().optional() }).strict(),
  "chat.snapshot": z.object({ ...session, cursor: z.uuid().optional(), includeSubtasks: z.boolean().optional(),
    includeTools: z.boolean().optional(), includeShell: z.boolean().optional(), includeActivities: z.boolean().optional(),
    includeImages: z.boolean().optional(), includePermissions: z.boolean().optional(),
    includeQuestions: z.boolean().optional(),
    includeTodos: z.boolean().optional() }).strict()
    .refine((body) => !body.includeShell || body.includeTools === true),
  "chat.subtask.snapshot": z.object({ ...session, parentSessionId: id,
    cursor: z.uuid().optional(), includeTools: z.boolean().optional(), includeShell: z.boolean().optional(), includeActivities: z.boolean().optional(),
    includeImages: z.boolean().optional(), includePermissions: z.boolean().optional(),
    includeQuestions: z.boolean().optional(),
    includeTodos: z.boolean().optional() }).strict()
    .refine((body) => !body.includeShell || body.includeTools === true),
  "chat.create": z.object(project).strict(),
  "chat.get": z.object(session).strict(),
  "chat.rename": z.object({ ...session, title: z.string().trim().min(1).max(512) }).strict(),
  "chat.fork": z.object(session).strict(),
  "chat.delete": z.object(session).strict(),
  "chat.models": z.object(project).strict(),
  "chat.prompt": z.object({ ...session, text: z.string().min(1).max(32000),
    mode: z.enum(["build", "plan"]).optional(),
    model: promptModel.optional() }).strict(),
  "chat.abort": z.object(session).strict(),
  // Never "always": persistent grants are outside scope. See CHAT-PERMISSIONS.md.
  "chat.permission.reply": z.object({ ...session, permissionId: id,
    response: z.enum(["once", "reject"]) }).strict(),
  // One answer per pending question, in the same order OpenCode's own batch reply
  // endpoint expects. Each entry is either positions into that question's option list,
  // or -- when that question's own `custom` flag allows it -- free text the user typed,
  // mirroring OpenCode's own TUI "type your own answer" affordance. `reject` declines
  // the whole pending batch outright and carries no answers; OpenCode's native reject
  // has no per-question form. See CHAT-QUESTIONS.md and ADR 0011.
  "chat.question.reply": z.object({ ...session, questionId: id,
    response: z.enum(["answer", "reject"]),
    answers: z.array(chatQuestionAnswerSchema).min(1).max(8).optional() }).strict()
    .refine((body) => body.response === "reject"
      ? body.answers === undefined
      : body.answers !== undefined),
} as const;
export const CHAT_CAPABILITIES = [...Object.keys(chatRequests), "chat.prompt.mode", "chat.prompt.model", "chat.tools", "chat.shell", "chat.activities", "chat.images", "chat.permissions", "chat.questions", "chat.todos"];
export type ChatOperation = keyof typeof chatRequests
export const projectSummarySchema = z.object({
  id: z.uuid(), name: z.string().min(1).max(256), path: z.string().min(1).max(4096),
}).strict();
export const chatSummarySchema = z.object({
  id, title: z.string().max(512), updatedAt: z.number().int().nonnegative(),
  parentId: id.optional(),
}).strict();
// A selectable model. `effortLevels` lists that model's own reported
// reasoning-effort variant ids (OpenCode's `variant` concept) when it
// supports one; absent for models with no variable-effort choice. Ids are
// whatever OpenCode itself names them, not a fixed set -- see CHAT-MODEL.md.
export const modelSummarySchema = z.object({
  providerID: id, providerName: z.string().min(1).max(256),
  modelID: id, modelName: z.string().min(1).max(256),
  effortLevels: z.array(id).min(1).max(10).optional(),
}).strict();
export type ChatModelSummary = z.infer<typeof modelSummarySchema>
const reasoningTime = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative().optional(),
}).strict().refine((time) => time.end === undefined || time.end >= time.start);
// Shared with chatPermissionSchema below: a permission request maps through
// the same presentation taxonomy a tool call does, not a parallel one.
const operation = z.enum(["read", "edit", "write", "search", "list", "execute", "fetch", "tool", "question"]);
export const chatMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("text"), text: z.string().max(48000) }).strict(),
  z.object({ id, type: z.literal("reasoning"), text: z.string().max(48000),
    time: reasoningTime.optional(), activity: activitySchema.optional() }).strict(),
  z.object({ id, type: z.literal("tool"), text: z.string().max(48000), activity: activitySchema.optional(),
    tool: z.object({
      operation,
      description: z.string().min(1).max(256).optional(),
      status: z.enum(["pending", "running", "completed", "error", "unknown"]),
      durationMs: z.number().int().nonnegative().optional(),
      shell: z.object({ command: z.string().max(8000), output: z.string().max(32000),
        truncated: z.boolean() }).strict().optional(),
    }).strict().refine((tool) => !tool.shell || tool.operation === "execute"),
  }).strict(),
  z.object({ id, type: z.literal("subtask"), text: z.string().max(48000), activity: activitySchema.optional(),
    task: z.object({
      title: z.string().min(1).max(512), agent: z.string().min(1).max(64),
      status: z.enum(["pending", "running", "retry", "completed", "error", "unknown"]),
      background: z.boolean(), sessionId: id.optional(),
      stats: z.object({ toolCalls: z.number().int().min(0).max(5000),
        complete: z.boolean(), durationMs: z.number().int().nonnegative().optional(),
      }).strict().optional(),
    }).strict(),
  }).strict(),
  // A bounded, re-encoded preview only — never the original file. See CHAT-IMAGES.md.
  z.object({ id, type: z.literal("image"), text: z.literal(""),
    image: z.object({
      mime: z.literal("image/jpeg"),
      data: z.base64().min(1).max(IMAGE_DATA_MAX),
      width: z.number().int().positive().max(8192).optional(),
      height: z.number().int().positive().max(8192).optional(),
    }).strict(),
  }).strict(),
]);
export type ChatMessagePart = z.infer<typeof chatMessagePartSchema>
export type ChatSubtask = Extract<ChatMessagePart, { type: "subtask" }>["task"]
export type ChatTool = Extract<ChatMessagePart, { type: "tool" }>["tool"]
export type ChatImage = Extract<ChatMessagePart, { type: "image" }>["image"]
// A pending permission request. Only what OpenCode itself prepared for
// display (its own bounded title, plus the same operation/pattern
// presentation already used for tools) crosses the boundary -- never raw
// native metadata. See CHAT-PERMISSIONS.md.
export const chatPermissionSchema = z.object({
  id, operation, description: z.string().min(1).max(256),
  pattern: z.string().min(1).max(256).optional(),
}).strict();
export type ChatPermission = z.infer<typeof chatPermissionSchema>
// A pending question batch OpenCode is blocked on. OpenCode's own `question` tool can
// ask several questions in one call; only what OpenCode itself prepared for display
// crosses the boundary for each -- its own bounded question text, short header and
// option labels/descriptions -- never tool input, model output or command text. The
// caps and sanitization are what make rendering agent-authored text safe on a phone.
// See CHAT-QUESTIONS.md.
export const chatQuestionOptionSchema = z.object({
  label: z.string().min(1).max(80),
  description: z.string().max(256).optional(),
}).strict();
// One question within a batch. Mirrors OpenCode's own per-question shape exactly --
// see CHAT-QUESTIONS.md.
export const chatQuestionPromptSchema = z.object({
  header: z.string().max(64), question: z.string().min(1).max(2000),
  options: z.array(chatQuestionOptionSchema).min(1).max(32),
  multiple: z.boolean(),
  // OpenCode's own "custom" flag on the question, defaulting true: whether its TUI (and
  // now this client) offers a free-text "type your own answer" alongside the fixed
  // options. A question can opt out (e.g. a strict yes/no) by setting it false.
  custom: z.boolean(),
}).strict();
// The whole pending batch shares one id, answered together through `chat.question.reply`'s
// `answers` array, in this same order. Capped at 8 questions -- a small, generous bound
// on a native list, mirroring this codebase's existing subtask-list cap.
export const chatQuestionSchema = z.object({
  id, questions: z.array(chatQuestionPromptSchema).min(1).max(8),
}).strict();
export type ChatQuestionOption = z.infer<typeof chatQuestionOptionSchema>
export type ChatQuestionPrompt = z.infer<typeof chatQuestionPromptSchema>
export type ChatQuestion = z.infer<typeof chatQuestionSchema>
// One entry of OpenCode's own task list for the session, as the agent's
// todowrite tool last wrote it. Only the display fields cross the boundary:
// the item's id, its bounded and sanitized text, and its state. OpenCode's
// `priority` is deliberately not forwarded -- nothing presents it, and the
// rule here is a presentation allowlist, not a raw passthrough. An
// unrecognized native status maps to "pending". See CHAT-TODOS.md.
export const chatTodoSchema = z.object({
  id, content: z.string().min(1).max(256),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
}).strict();
export type ChatTodo = z.infer<typeof chatTodoSchema>
const message = z.object({
  id, role: z.enum(["user", "assistant"]), text: z.string().max(48000),
  truncated: z.boolean(),
  incomplete: z.boolean().optional(),
  // The agent the message was generated under, when it was build/plan --
  // absent for a custom agent name or when unknown.
  mode: z.enum(["build", "plan"]).optional(),
  parts: z.array(chatMessagePartSchema).max(100).optional(),
}).strict().refine((message) => !message.parts || (
  // Tool/subtask/reasoning parts stay assistant-only; a user message may only
  // carry its own authored text and image attachments as structured parts.
  (message.role === "assistant" ||
    message.parts.every((part) => part.type === "text" || part.type === "image")) &&
  new Set(message.parts.map((part) => part.id)).size === message.parts.length &&
  message.parts.reduce((length, part) => length + part.text.length +
    (part.type === "tool" && part.tool.shell ? part.tool.shell.command.length + part.tool.shell.output.length : 0) +
    (part.type === "image" ? part.image.data.length : 0), 0) <= 48000 &&
  (!message.parts.some((part) => part.type === "tool" && part.tool.shell?.truncated) || message.truncated) &&
  message.parts.filter((part) => part.type !== "reasoning" && part.type !== "image")
    .map((part) => part.text).join("") === message.text
));
const snapshot = z.object({ ...version, chat: chatSummarySchema, messages: z.array(message).max(10),
  cursor: z.uuid().nullable(), status: z.enum(["idle", "busy", "retry", "unknown"]),
  permission: chatPermissionSchema.nullable().optional(),
  // Present only for a client that opted in; null when nothing is pending.
  question: chatQuestionSchema.nullable().optional(),
  // The session's task list, newest write wins, in OpenCode's own order.
  // Absent for a client that didn't opt in; `[]` when it did and the session
  // has no tasks. Ids are unique within one list. See CHAT-TODOS.md.
  todos: z.array(chatTodoSchema).max(100)
    .refine((todos) => new Set(todos.map((todo) => todo.id)).size === todos.length).optional(),
  // The model (and effort, if set) the most recent assistant reply actually
  // used -- only present on an unpaginated (latest-page) snapshot, so a
  // client can recover what a previously-opened chat is using. Absent for a
  // chat with no assistant reply yet, or an earlier-history page.
  model: promptModel.optional() }).strict();
export const chatResponses = {
  "project.list": z.object({ ...version, projects: z.array(projectSummarySchema).max(100), pathEntry: z.boolean() }).strict(),
  "project.open": z.object({ ...version, project: projectSummarySchema }).strict(),
  "chat.list": z.object({ ...version, chats: z.array(chatSummarySchema).max(50), cursor: z.uuid().nullable() }).strict(),
  "chat.snapshot": snapshot,
  "chat.subtask.snapshot": snapshot,
  "chat.create": z.object({ ...version, chat: chatSummarySchema }).strict(),
  "chat.get": z.object({ ...version, chat: chatSummarySchema }).strict(),
  "chat.rename": z.object({ ...version, chat: chatSummarySchema }).strict(),
  "chat.fork": z.object({ ...version, chat: chatSummarySchema }).strict(),
  "chat.delete": z.object({ ...version, deleted: z.literal(true) }).strict(),
  "chat.models": z.object({ ...version, models: z.array(modelSummarySchema).max(200) }).strict(),
  "chat.prompt": z.object({ ...version, accepted: z.literal(true) }).strict(),
  "chat.abort": z.object({ ...version, accepted: z.literal(true) }).strict(),
  "chat.permission.reply": z.object({ ...version, accepted: z.literal(true) }).strict(),
  "chat.question.reply": z.object({ ...version, accepted: z.literal(true) }).strict(),
} as const;
