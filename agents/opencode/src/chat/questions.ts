import type { PluginInput } from "@opencode-ai/plugin";
import { questionSummary, type QuestionRequest, type AnsweredQuestionBatch } from "../chat-message.js";
import type { LiveParts } from "../live-parts.js";
import { ChatAccessError } from "./access-error.js";
import { unwrapResult } from "./sdk-result.js";
import type { Workspace, WorkspaceRegistry } from "./workspace.js";

type Client = PluginInput["client"]
type PendingQuestion = ReturnType<typeof questionSummary>

// Unlike a pending permission, v1 does have a list endpoint for questions (see ADR
// 0011): GET /question returns every pending request across all sessions. Event
// capture is tried first elsewhere since it's lower latency and matches the
// permission path, but a snapshot with no live subscription -- or one that
// (re)subscribed after the question was already asked -- previously saw nothing,
// so the question never reached the client and only the underlying blocked tool
// call showed, stuck, forever. This closes that gap the same way todos does:
// readable on demand, and a transient failure yields "no question" rather than a
// leaked native error.
export async function fetchPendingQuestion(client: Client, registry: WorkspaceRegistry, workspace: Workspace,
    sessionId: string, signal: AbortSignal): Promise<PendingQuestion> {
  try {
    const options = { ...registry.options(workspace), signal, url: "/question" };
    const list = unwrapResult(await client.session.list(options)) as unknown;
    const pending = Array.isArray(list)
      ? (list as ({ sessionID?: unknown } | null | undefined)[])
        .find((entry) => entry?.sessionID === sessionId) as QuestionRequest | undefined
      : undefined;
    return pending ? questionSummary(pending) : undefined;
  } catch {
    return undefined;
  }
}

/// Resolves the pending question an answer refers to, without trusting the client for
/// anything but its id. Live state is keyed by stream subscription and the dispatcher
/// passes none for a plain request, so a reply cannot rely on the `live` argument; it
/// falls back to any live subscription holding the question, then to OpenCode's own
/// pending list, exactly as the snapshot does. Resolving against a question the plugin
/// itself observed is what keeps client-supplied text from reaching the agent, so a miss
/// stays a hard failure.
export async function resolvePendingQuestion(liveParts: ReadonlyMap<string, LiveParts>, client: Client,
    registry: WorkspaceRegistry, workspace: Workspace, sessionId: string, questionId: string, signal: AbortSignal,
    live?: LiveParts): Promise<PendingQuestion> {
  const captured = live?.question?.id === questionId
    ? live.question
    : [...liveParts.values()].find((parts) => parts.question?.id === questionId)?.question;
  if (captured) return questionSummary(captured);
  const native = await fetchPendingQuestion(client, registry, workspace, sessionId, signal);
  return native?.id === questionId ? native : undefined;
}

// Submits a reply to (or rejection of) a pending question. Returns the accepted result
// together with the batch to remember, if any, so a completed `question` tool part can
// later show what was asked and chosen -- see ADR 0011, "Update: a persisted asked/
// answered record". The caller is responsible for actually recording it.
export async function replyToQuestion(client: Client, registry: WorkspaceRegistry, workspace: Workspace,
    questionId: string, body: Record<string, unknown>, pending: PendingQuestion,
    signal: AbortSignal): Promise<{ result: { version: 1; accepted: true }; recorded?: AnsweredQuestionBatch }> {
  // The SDK client this plugin is handed exposes no question operation at all, so the
  // reply goes through its ordinary transport against a fixed route -- the same
  // technique, and the same constraint, as the event shim: the route is a constant
  // here and no part of it is selected by the remote client. See ADR 0011.
  //
  // The borrowed method must itself be a POST. Generated methods bind their verb as
  // `request({ ...options, method })`, so a `method` passed in options is overwritten,
  // never honored: routing a reply through a GET-based method (session.list) sent
  // `GET /question/{id}/reply`, which OpenCode rejected, and every answer failed.
  // postSessionIdPermissionsPermissionId is the POST-with-JSON-body transport already
  // used for permission replies; only its `url` is overridden, and it carries no path
  // placeholders once replaced, so no `path` is needed.
  const reject = body.response === "reject";
  // An indexed answer resolves to the label OpenCode itself supplied, from the question
  // the plugin captured -- so a selection can never assert text the model didn't write.
  // Free text is different: a given entry's own `custom` flag (mirroring OpenCode's TUI
  // "type your own answer") is what allows it through at all, and it is forwarded as
  // the user typed it, the same way `chat.prompt` already forwards free text. See ADR 0011.
  let answers: string[][] = [];
  if (!reject) {
    // Resolving against the captured batch is also the freshness check: a batch that
    // has already been answered or replaced no longer resolves. One answer is required
    // per question, in order -- OpenCode's own batch reply has no per-question form, so
    // a short or long list can never be forwarded as if it matched.
    if (!pending) throw new ChatAccessError("context_expired");
    const submitted = Array.isArray(body.answers) ? body.answers as Record<string, unknown>[] : [];
    if (submitted.length !== pending.questions.length) throw new ChatAccessError("context_expired");
    answers = pending.questions.map((question, index) => {
      const answer = submitted[index];
      if (typeof answer?.text === "string") {
        if (!question.custom) throw new ChatAccessError("context_expired");
        return [answer.text];
      }
      const selected = Array.isArray(answer?.selected) ? answer.selected as number[] : [];
      const labels = selected.map((optionIndex) => question.options[optionIndex]?.label)
        .filter((label): label is string => typeof label === "string");
      if (!labels.length || labels.length !== selected.length) {
        throw new ChatAccessError("context_expired");
      }
      return labels;
    });
  }
  const result = await client.postSessionIdPermissionsPermissionId({
    ...registry.options(workspace), signal,
    url: reject ? `/question/${encodeURIComponent(questionId)}/reject`
      : `/question/${encodeURIComponent(questionId)}/reply`,
    ...(reject ? {} : { body: { answers } }),
  } as never);
  if (result.error || !result.response.ok) throw new Error("OpenCode question reply was not accepted");
  // Remembered from what the plugin itself just resolved -- never OpenCode's native
  // tool output/metadata -- so a completed `question` tool part can later show what
  // was asked and chosen. See ADR 0011, "Update: a persisted asked/answered record".
  return { result: { version: 1, accepted: true }, ...(pending ? { recorded: { questions: pending.questions,
    answers: reject ? pending.questions.map(() => "Declined") : answers.map((labels) => labels.join(", ")) } } : {}) };
}
