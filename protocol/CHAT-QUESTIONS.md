# Question Presentation v1

`chat.questions` is a display and reply capability for OpenCode's own
`question` tool: the agent can pause and ask the operator one or more
questions, each with a header, its text, and a list of options, and wait for
an answer before continuing. A locally attached TUI already renders this;
this capability lets a supporting remote client do the same. See
ADR 0011 (`packages/agents/opencode/docs/adr/0011-remote-question-answers.md`)
for the full design history, including why v1 (not v2) and why free text is
allowed at all.

Like `chat.permissions`, this is a mutating, execution-gating capability: an
answer unblocks the agent. Unlike a tool part or a todo, question and option
text are authored by the model and forwarded verbatim (bounded and
sanitized) — see ADR 0011's threat analysis for why that is a deliberate,
narrow exception to this protocol's no-tool-input rule.

## Negotiation

A supporting client requests `includeQuestions: true` on `chat.snapshot`,
`chat.subtask.snapshot`, or `chat.stream.subscribe` only when the connector
advertises `chat.questions`. Omitting or disabling it preserves today's
behavior exactly: no `question` field at all. The chat protocol remains
version 1.

## Batches

OpenCode's `question` tool can ask several questions in one call. All of
them arrive, and are answered, together as one batch sharing a single id —
there is no way to answer one question in a batch without also answering (or
rejecting) the whole batch, because OpenCode's own reply endpoint has no
per-question form. A snapshot may carry:

```json
{
  "question": {
    "id": "qst_0123456789abcdefghijklmn",
    "questions": [
      {
        "header": "Migration safety",
        "question": "The backfill will rewrite 50M rows. How should it run?",
        "options": [
          { "label": "Online backfill", "description": "Batched writes, no table lock" },
          { "label": "Maintenance window", "description": "Faster, but the API is unavailable" }
        ],
        "multiple": false,
        "custom": true
      },
      {
        "header": "Targets",
        "question": "Which platforms should the release cover?",
        "options": [{ "label": "iOS" }, { "label": "Android" }],
        "multiple": true,
        "custom": false
      }
    ]
  }
}
```

`question` is absent for a client that didn't opt in, `null` when nothing is
currently pending, and this shape when something is. `questions` holds at
least one and at most 8 entries, in OpenCode's own order — a small, generous
bound on a native list, the same kind of cap this codebase already applies
elsewhere to a native list (e.g. subtasks). A single question asked alone is
simply a one-entry batch; there is no separate "single question" shape.

Each entry's `question` (bounded to 2000 UTF-16 units), `header` (64), and
each option's `label` (80) and `description` (256) are OpenCode's own
prepared text, sanitized the same way every agent-authored field in this
protocol is — control characters and bidi overrides stripped. `options` has
at least one and at most 32 entries. `multiple` allows selecting more than
one option for that entry; `custom` (OpenCode's own flag, default true)
allows a free-text answer for that entry in place of any option, mirroring
OpenCode's own TUI "type your own answer" affordance. Either flag can differ
entry to entry within the same batch — nothing ties them together.

**No other native field crosses this boundary.** Tool input, model output,
command text and native metadata are never forwarded, matching every other
capability's presentation-allowlist rule.

## Reply

```json
{
  "questionId": "qst_0123456789abcdefghijklmn",
  "response": "answer",
  "answers": [{ "selected": [0] }, { "selected": [0, 1] }]
}
```

`answers` carries exactly one entry per question in the batch, in the same
order. Each entry is either `{ "selected": [...] }` — zero-indexed positions
into that question's own `options` (bounded to the same 32-entry cap, never
empty) — or, only when that question's own `custom`
flag allows it, `{ "text": "..." }` — free text the user typed, bounded to
2000 characters and forwarded exactly as typed, the same way `chat.prompt`
already forwards free text (see ADR 0011's "Update: free-text answers").

`response: "reject"` declines the **whole batch** and carries no `answers` —
OpenCode's native reject has no per-question form, so there is no way to
answer some questions in a batch and decline the rest. A malformed or
mismatched reply (wrong `answers` length, an entry with both `selected` and
`text`, `text` for a question whose `custom` is false, an index outside that
question's own option list, `answers` present on a `reject`) fails before
anything reaches OpenCode; index resolution doubles as the freshness check
described in ADR 0011 — a batch already answered or replaced no longer
resolves, and the reply fails with `context_expired`.

`chat.question.reply` requires the same project/session authorization and
child-session membership checks every other mutating operation already
requires. A successful reply returns `{ accepted: true }`.

## Visibility

Unlike a pending permission, OpenCode's v1 API does have a list endpoint for
pending questions (`GET /question`), so a cold snapshot recovers a batch that
started before any client was subscribed — see ADR 0011 for why event
capture is still tried first. A read failure yields "no question", never a
leaked native error.

## The transcript record

Once a batch is answered or rejected, `chat.tools`' `question`-operation tool
part (see `CHAT-TOOLS.md`) carries a `description` summarizing what was asked
and chosen — e.g. `"Environment: Local · Platform: Android"` — instead of the
generic fallback every unrecognized native tool otherwise gets. This is never
sourced from OpenCode's own tool output or metadata for the completed call
(unconfirmed and untrusted); it is built entirely from the tool's own
already-sanitized `questions` input plus the plugin's own record of what it
resolved at reply time, matched by comparing sanitized question content, not
a native id. It is a process-lifetime convenience, not a durable history: a plugin
restart, or a session aging out of a small bound, loses the "answered" half
and falls back to showing only what was asked. See ADR 0011, "Update: a
persisted asked/answered record."

## Threat analysis

See ADR 0011 for the full analysis; in summary:

- An answer only ever asserts an option label OpenCode itself supplied, or —
  for an entry that opts in — free text the user typed. It can never inject
  a label the model did not write.
- Answering a batch grants nothing on its own; any privileged action the
  agent takes afterward still passes through its own permission prompt
  (`chat.permissions`), which is a separate approval.
- The batch cap (8 questions, 32 options each) and per-field text bounds keep
  a hostile or malformed batch from flooding the client or pushing controls
  off screen. The client renders all of it as plain text — never Markdown,
  never a link.
- Reject is whole-batch by design, matching OpenCode's own endpoint; a client
  cannot be tricked into silently discarding some of a batch while answering
  the rest, because there is no such partial-reply request to send.

The shared `chat-questions-v1.json` fixture covers a single-question batch,
a two-question batch, an oversized batch, an empty batch, and both answer
and reject replies, including every malformed combination (mismatched
answer count, both/neither of `selected` and `text`, `text` on a
`custom: false` entry, an out-of-range index, `answers` on a `reject`).
Protocol tests cover strict field validation and the opt-in/absent/null/
object states. Plugin tests cover mapping the full ordered list from
OpenCode's native event, live capture/clear across a reply resolving the
whole batch, and the per-entry authorization checks on the reply operation.
Mobile tests cover strict parsing of the batch shape and the paged banner.
