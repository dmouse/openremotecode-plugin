import type { PluginInput } from "@opencode-ai/plugin";
import { chatMessageContent, permissionSummary, questionSummary, resolveImages, todoSummaries } from "../chat-message.js";
import type { LiveParts } from "../live-parts.js";
import { readMessageHistory } from "../message-history.js";
import { ChatAccessError } from "./access-error.js";
import type { AnsweredQuestionMemory } from "./answered-questions.js";
import type { CursorStore } from "./cursor.js";
import { lastAssistantModel } from "./prompt.js";
import { fetchPendingQuestion } from "./questions.js";
import { unwrapResult } from "./sdk-result.js";
import { getChildSession, getSession } from "./session-access.js";
import { resolveSubtasks } from "./subtasks.js";
import { toChatSummary } from "./summary.js";
import type { Workspace, WorkspaceRegistry } from "./workspace.js";

type Client = PluginInput["client"]
type Session = NonNullable<Awaited<ReturnType<Client["session"]["get"]>>["data"]>

// OpenCode's own per-session task list. Unlike a pending permission this is
// readable on demand, so a cold snapshot recovers it without having been
// subscribed when it was written. A transient failure yields an empty list,
// never a leaked native error -- the same spirit as fetchProjectMcpStatus.
async function fetchTodos(client: Client, registry: WorkspaceRegistry, workspace: Workspace, sessionId: string,
    signal: AbortSignal) {
  try {
    return todoSummaries(unwrapResult(await client.session.todo({ ...registry.options(workspace), signal,
      path: { id: sessionId } })));
  } catch {
    return [];
  }
}

export interface SnapshotRequest {
  client: Client
  registry: WorkspaceRegistry
  cursors: CursorStore
  answeredQuestions: AnsweredQuestionMemory
  workspace: Workspace
  session: Session
  sessionId: string
  operation: "chat.snapshot" | "chat.subtask.snapshot"
  body: Record<string, unknown>
  live: LiveParts | undefined
  signal: AbortSignal
}

// Assembles a full chat.snapshot/chat.subtask.snapshot response: message history, status,
// todos, the pending permission/question, subtask enrichment, and the live-overlay
// projection of every message -- re-verifying session membership after every native read
// that ran concurrently with it.
export async function buildChatSnapshot(request: SnapshotRequest): Promise<unknown> {
  const { client, registry, cursors, answeredQuestions, workspace, session, sessionId, operation, body, live, signal } = request;
  const before = cursors.resolve(body, workspace.id, sessionId);
  const history = await readMessageHistory(client, workspace.path, sessionId, before, signal);
  const messages = history.messages;
  const statuses = unwrapResult(await client.session.status({ ...registry.options(workspace), signal }));
  const todos = body.includeTodos === true ? await fetchTodos(client, registry, workspace, sessionId, signal) : undefined;
  // Only queried when nothing was captured live -- the event path stays the
  // low-latency default, this is strictly a cold/missed-event fallback.
  const questions = body.includeQuestions === true && !live?.question
    ? await fetchPendingQuestion(client, registry, workspace, sessionId, signal) : undefined;
  const subtasks = body.includeSubtasks === true || operation === "chat.subtask.snapshot"
    ? await resolveSubtasks(client, registry, workspace, sessionId,
      messages.filter((m) => m.info.role === "assistant").flatMap((m) => m.parts.slice(0, 100)), statuses,
      AbortSignal.any([signal, AbortSignal.timeout(4000)])) : undefined;
  // Recheck membership after concurrent SDK reads, too.
  await registry.get(workspace.id);
  if (operation === "chat.subtask.snapshot") {
    await getChildSession(client, registry, workspace, String(body.parentSessionId), sessionId, signal);
  } else if ((await getSession(client, registry, workspace, sessionId, signal)).parentID) {
    throw new ChatAccessError("access_denied");
  }
  if (live) {
    for (const { info } of messages) if (info.role === "assistant" && info.time?.completed !== undefined) live.next.remove(info.id);
  }
  // Only the unpaginated (latest-page) fetch reliably contains the true
  // most recent reply; an earlier-history page must not report a stale
  // model as if it were current.
  const model = before === undefined ? lastAssistantModel(messages) : undefined;
  const status = statuses[sessionId]?.type ?? "idle";
  const pendingQuestion = live?.question ? questionSummary(live.question) : questions;
  // An interrupted run never writes a terminal state for the tool it was in
  // the middle of, so that part stays "running" in OpenCode's stored history
  // forever and a client keeps animating work that ended long ago. An idle
  // session with nothing waiting on the user is what proves those parts are
  // abandoned rather than blocked. A pending question is only known from a
  // live capture or the caller's negotiated fallback read, so without either
  // source the raw state is left alone. See ADR 0012.
  const settled = status === "idle" && !live?.permission && !pendingQuestion &&
    (live !== undefined || body.includeQuestions === true);
  return { version: 1, chat: toChatSummary(session),
    cursor: cursors.issue(history.cursor, workspace.id, sessionId),
    status,
    ...(model ? { model } : {}),
    // v1 has no endpoint to list pending permissions; the event-captured
    // value on the live subscription (if any) is the only source. See
    // CHAT-PERMISSIONS.md.
    ...(body.includePermissions === true
      ? { permission: live?.permission ? permissionSummary(live.permission) : null } : {}),
    // The event-captured value is preferred when present; `questions` is only
    // populated when there was none, as an on-demand fallback read (see
    // fetchPendingQuestion). Either way questionSummary returns undefined for
    // anything it cannot present, which surfaces as "nothing pending".
    ...(body.includeQuestions === true ? { question: pendingQuestion ?? null } : {}),
    // A live subscription's event-captured list, when it has one, is at
    // least as current as this read. See CHAT-TODOS.md.
    ...(todos ? { todos: live?.todos ?? todos } : {}),
    messages: await Promise.all(messages.map(async ({ info, parts }) => {
      if (info.sessionID !== sessionId) throw new ChatAccessError("access_denied");
      if (live) parts = live.overlay(info.id, parts, info.role === "assistant" && info.time?.completed !== undefined);
      // Image decode/resize is CPU-bound async work; only ever awaited here,
      // never on the live streaming overlay path (see chat-message.ts).
      const images = body.includeImages === true ? await resolveImages(parts) : undefined;
      const agent = info.role === "user" ? info.agent : info.mode;
      return { id: info.id, role: info.role, ...chatMessageContent(info.role, parts, subtasks,
        { includeTools: body.includeTools === true, includeShell: body.includeShell === true,
          includeActivities: body.includeActivities === true, ...(images ? { images } : {}),
          messageFinished: info.role === "assistant" && info.time?.completed !== undefined,
          sessionSettled: settled,
          directory: workspace.path, answeredQuestions: answeredQuestions.get(sessionId) }),
        ...(agent === "build" || agent === "plan" ? { mode: agent } : {}),
        ...(live?.incomplete(info.id) ? { incomplete: true } : {}) };
    })) };
}
