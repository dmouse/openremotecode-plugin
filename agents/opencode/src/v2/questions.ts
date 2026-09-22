import { z } from "zod";
import { sanitizeQuestionPrompt, type AnsweredQuestionBatch } from "../chat-message.js";
import type { ChatQuestion } from "@openremotecode/protocol";
import { ChatAccessError } from "../chat/access-error.js";
import type { V2Client, V2RequestOptions } from "./client.js";

// v2 has no dedicated question API; OpenCode's own "question" tool is believed to ask through
// the general-purpose Form API instead (session.form.*), one field per question -- inferred from
// a synthetic test-session simulator found in the binary, not confirmed against a real model
// turn. See ADR 0013. Rather than trust that inference for *content* (field naming, a "kind"
// marker, free-text defaults), a form is read generically and only recognized as an answerable
// question batch when every field is independently recognizable as one: a bounded multiselect or
// a bounded string, each with a fixed option list, none hidden or conditional. A form with any
// field outside that shape is not a trust decision to make -- it is simply never surfaced as a
// question, exactly like an unrecognized permission or tool.
const option = z.object({ value: z.string().min(1).max(4096), label: z.string().min(1).max(4096),
  description: z.string().max(4096).optional() }).loose();
const field = z.object({
  key: z.string().min(1).max(128),
  type: z.enum(["string", "number", "integer", "boolean", "multiselect", "external"]),
  title: z.string().optional(),
  hidden: z.boolean().optional(),
  when: z.array(z.unknown()).optional(),
  options: z.array(option).max(64).optional(),
  maxItems: z.number().optional(),
  custom: z.boolean().optional(),
}).loose();
const form = z.object({ id: z.string().min(1).max(128), sessionID: z.string(),
  fields: z.array(field).min(1).max(8) }).loose();
const formList = z.array(form).max(64);

interface QuestionOption { readonly value: string; readonly label: string; readonly description?: string | undefined }
interface QuestionField { readonly key: string; readonly type: "string" | "multiselect"; readonly options: readonly QuestionOption[] }

export interface PendingV2Question {
  readonly id: string
  readonly questions: ChatQuestion["questions"]
  readonly fields: readonly QuestionField[]
}

function recognize(candidate: z.infer<typeof form>): PendingV2Question | undefined {
  const pairs = candidate.fields.map((f) => {
    if (f.hidden === true || (f.when?.length ?? 0) > 0) return undefined;
    if (f.type !== "string" && f.type !== "multiselect") return undefined;
    if (!f.options?.length) return undefined;
    // v2's own default for a form field's free-text affordance is not confirmed (unlike v1's
    // tool, whose default-true is documented); defaulting to *not* allowed is the safer
    // uncertain-default, since it fails toward less reaching the agent, not more.
    const multiple = f.type === "multiselect" && f.maxItems !== 1;
    const prompt = sanitizeQuestionPrompt({ header: "", question: f.title, options: f.options,
      multiple, custom: f.custom === true });
    if (!prompt) return undefined;
    return { field: { key: f.key, type: f.type, options: f.options }, prompt };
  });
  // Any field that doesn't qualify voids the whole form, rather than silently dropping a
  // question the agent is actually waiting on an answer to.
  if (pairs.some((p) => p === undefined)) return undefined;
  const resolved = pairs as NonNullable<(typeof pairs)[number]>[];
  return resolved.length ? { id: candidate.id, questions: resolved.map((p) => p.prompt), fields: resolved.map((p) => p.field) } : undefined;
}

export async function fetchPendingV2Question(client: V2Client, sessionId: string,
    signal: AbortSignal): Promise<PendingV2Question | undefined> {
  try {
    const list = formList.parse(await client.session.form.list({ sessionID: sessionId }, { signal }));
    for (const candidate of list) {
      if (candidate.sessionID !== sessionId) continue;
      const recognized = recognize(candidate);
      if (recognized) return recognized;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function replyToV2Question(client: V2Client, sessionId: string, pending: PendingV2Question,
    body: Record<string, unknown>, signal: AbortSignal):
    Promise<{ result: { version: 1; accepted: true }; recorded: AnsweredQuestionBatch }> {
  const options = (): V2RequestOptions => ({ signal });
  if (body.response === "reject") {
    await client.session.form.cancel({ sessionID: sessionId, formID: pending.id }, options());
    return { result: { version: 1, accepted: true },
      recorded: { questions: pending.questions, answers: pending.questions.map(() => "Declined") } };
  }
  const submitted = Array.isArray(body.answers) ? body.answers as Record<string, unknown>[] : [];
  if (submitted.length !== pending.questions.length) throw new ChatAccessError("context_expired");
  const answer: Record<string, string | string[]> = {};
  const displayAnswers: string[] = [];
  pending.questions.forEach((question, index) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- recognize() built fields to the same length/order as questions
    const questionField = pending.fields[index]!;
    const submittedAnswer = submitted[index];
    if (typeof submittedAnswer?.text === "string") {
      if (!question.custom) throw new ChatAccessError("context_expired");
      answer[questionField.key] = questionField.type === "multiselect" ? [submittedAnswer.text] : submittedAnswer.text;
      displayAnswers.push(submittedAnswer.text);
      return;
    }
    const selected = Array.isArray(submittedAnswer?.selected) ? submittedAnswer.selected as number[] : [];
    // A "string" field holds a single value; more than one selection has nothing valid to resolve
    // to, so it fails closed the same way an out-of-range index already does.
    if (questionField.type === "string" && selected.length > 1) throw new ChatAccessError("context_expired");
    const chosen = selected.map((optionIndex) => questionField.options[optionIndex])
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    if (!chosen.length || chosen.length !== selected.length) throw new ChatAccessError("context_expired");
    // The form's own stable option value is submitted -- never the display label, which is
    // cosmetic and could change independently of what the field actually accepts.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- chosen.length was just checked non-zero
    answer[questionField.key] = questionField.type === "multiselect" ? chosen.map((o) => o.value) : chosen[0]!.value;
    displayAnswers.push(chosen.map((o) => o.label).join(", "));
  });
  await client.session.form.reply({ sessionID: sessionId, formID: pending.id, answer }, options());
  return { result: { version: 1, accepted: true }, recorded: { questions: pending.questions, answers: displayAnswers } };
}
