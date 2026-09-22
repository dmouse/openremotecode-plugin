import { z } from "zod";
import { chatMessageContent, permissionSummary, questionSummary, resolveImages } from "../chat-message.js";
import { ChatAccessError, ChatUnsupportedError } from "../chat/access-error.js";
import type { AnsweredQuestionBatch } from "../chat-message.js";
import type { CursorStore } from "../chat/cursor.js";
import { lastAssistantModel } from "../chat/prompt.js";
import type { Workspace } from "../chat/workspace.js";
import { convertNextMessage } from "../message-history.js";
import type { V2Client } from "./client.js";
import { fetchPendingV2Question } from "./questions.js";
import { resolveV2Subtasks } from "./subtasks.js";

// Snapshot pages hold at most ten messages, the protocol's own limit.
const PAGE_SIZE = 10;

// A client may only opt into what the connector advertises. These flags ask for richer content
// the v2 adapter cannot yet project, so they are refused rather than silently ignored.
const UNSUPPORTED_OPT_INS = ["includeTodos"] as const;

// v2 mixes chat content with bookkeeping messages (agent, model and location switches, system,
// skill, compaction, idle). Only user and assistant messages are chat content, and kinds this
// build has never heard of are skipped too, so a newer server cannot break history.
const CHAT_TYPES = new Set(["user", "assistant"]);

const page = z.object({
  data: z.array(z.object({ type: z.string() }).loose()).max(PAGE_SIZE),
  cursor: z.object({ next: z.string().max(16_000).nullish() }).loose(),
});
const active = z.record(z.string(), z.object({ type: z.string() }).loose());
const permissions = z.array(z.object({
  id: z.string().min(1).max(128), sessionID: z.string(), action: z.string(), resources: z.array(z.string()).max(64),
}).loose()).max(64);

export interface V2SnapshotRequest {
  client: V2Client
  cursors: CursorStore
  workspace: Workspace
  chat: unknown
  sessionId: string
  body: Record<string, unknown>
  signal: AbortSignal
  /// "chat.subtask.snapshot" always resolves this session's own task-tool calls, matching v1's
  /// behavior of showing a subtask view's own nested subtasks without a separate opt-in.
  operation: "chat.snapshot" | "chat.subtask.snapshot"
  /// This session's own remembered answered/rejected question batches, for a completed
  /// `question` tool call's description. See ADR 0011's "persisted asked/answered record".
  answeredQuestions: readonly AnsweredQuestionBatch[]
  /// Re-verifies the session still belongs to the workspace, after reads that ran concurrently.
  recheck: () => Promise<void>
}

export async function buildV2Snapshot(request: V2SnapshotRequest): Promise<unknown> {
  const { client, cursors, workspace, chat, sessionId, body, signal } = request;
  for (const flag of UNSUPPORTED_OPT_INS) {
    if (body[flag] === true) throw new ChatUnsupportedError(`chat.snapshot.${flag}`);
  }
  const before = cursors.resolve(body, workspace.id, sessionId);
  const options = { signal };
  // The first page is the newest; the cursor it returns then continues into older history.
  const result = page.parse(await client.message.list(
    { sessionID: sessionId, limit: PAGE_SIZE, ...(before ? { cursor: before } : { order: "desc" as const }) }, options));
  const [running, pending, pendingQuestion] = await Promise.all([
    client.session.active(options),
    body.includePermissions === true ? client.permission.list({ sessionID: sessionId }, options) : undefined,
    body.includeQuestions === true ? fetchPendingV2Question(client, sessionId, signal) : undefined,
  ]);
  await request.recheck();

  const messages = result.data.filter((m) => CHAT_TYPES.has(m.type)).map((m) => convertNextMessage(m, sessionId)).reverse();
  // v2 returns a next cursor even on the last page, so a short page is what ends the history.
  const more = result.data.length >= PAGE_SIZE ? result.cursor.next ?? null : null;
  const model = before === undefined ? lastAssistantModel(messages) : undefined;
  const pendingPermission = pending === undefined ? undefined
    : permissions.parse(pending).find((entry) => entry.sessionID === sessionId);
  const runningParsed = active.parse(running);
  const status = runningParsed[sessionId]?.type === "running" ? "busy" : "idle";
  const subtasks = body.includeSubtasks === true || request.operation === "chat.subtask.snapshot"
    ? await resolveV2Subtasks(client, workspace, sessionId,
        messages.filter((m) => m.info.role === "assistant").flatMap((m) => m.parts.slice(0, 100)),
        runningParsed, AbortSignal.any([signal, AbortSignal.timeout(4000)]))
    : undefined;
  // v2 has no live overlay (unlike v1's LiveParts), so pendingPermission/pendingQuestion are only
  // known accurate here when this exact request opted into both -- otherwise "nothing pending" may
  // just mean "never asked", and a part must not be presented as abandoned on that weaker basis.
  // See ADR 0012 and src/chat/snapshot.ts's own `settled`.
  const sessionSettled = status === "idle" && !pendingPermission && !pendingQuestion &&
    body.includePermissions === true && body.includeQuestions === true;
  return {
    version: 1,
    chat,
    cursor: cursors.issue(more, workspace.id, sessionId),
    status,
    ...(model ? { model } : {}),
    ...(body.includePermissions === true ? { permission: pendingPermission
      ? permissionSummary({ id: pendingPermission.id, sessionID: sessionId, permission: pendingPermission.action, patterns: pendingPermission.resources })
      : null } : {}),
    ...(body.includeQuestions === true ? { question: pendingQuestion
      ? questionSummary({ id: pendingQuestion.id, sessionID: sessionId, questions: pendingQuestion.questions })
      : null } : {}),
    messages: await Promise.all(messages.map(async ({ info, parts }) => {
      if (info.sessionID !== sessionId) throw new ChatAccessError("access_denied");
      const agent = info.role === "user" ? info.agent : info.mode;
      const messageFinished = info.role === "assistant" && info.time?.completed !== undefined;
      const images = body.includeImages === true ? await resolveImages(parts) : undefined;
      return { id: info.id, role: info.role,
        ...chatMessageContent(info.role, parts, subtasks, {
          includeTools: body.includeTools === true, includeShell: body.includeShell === true,
          includeActivities: body.includeActivities === true, messageFinished, sessionSettled,
          directory: workspace.path, ...(images ? { images } : {}), answeredQuestions: request.answeredQuestions }),
        ...(agent === "build" || agent === "plan" ? { mode: agent } : {}) };
    })),
  };
}
