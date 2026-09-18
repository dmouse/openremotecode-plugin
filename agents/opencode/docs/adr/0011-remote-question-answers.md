# ADR 0011: Remote Question Answers

## Status

Accepted and implemented across the protocol, plugin and mobile client.

## Context

OpenCode can block on a question: the agent asks the operator to choose between options and
waits. The TUI renders the question and its choices. The remote client rendered nothing
useful — the question surfaced only as the blocked tool call, which fell through
`toolSummary`'s unknown-tool branch and appeared as "Question / Running" forever, because
nothing in the product could answer it.

Two separate gaps produced that. The plugin never subscribed to `question.*` events, so it
never saw the question at all. And even if it had, `toolSummary` carries an explicit rule —
*never forward arbitrary tool input, command strings, URLs, outputs or errors* — under which
the question text and its option labels are exactly the kind of payload that does not cross
the boundary.

Permissions are the same shape of problem, already solved: a pending request captured from
an event, normalized to a bounded display summary, surfaced on the snapshot behind an opt-in,
and answered through a single narrow operation. Questions follow that design.

The SDK declares two question families, `question.*` and `question.v2.*`, with structurally
identical payloads. This decision uses v1.

## Decision

- **v1, not v2.** The plugin's entire integration is on the v1 surface: the client the
  OpenCode plugin context supplies is `OpencodeClient` from the root SDK, and the permission
  reply already goes through it. On the pinned OpenCode 1.18.31, `GET /question` answers 200
  with the pending list, so v1 is live, and unlike v1 permissions it has a list endpoint if
  event capture ever proves insufficient.
- **The reply uses a fixed route through the ordinary client transport.** The supplied v1
  client exposes no question operation — there are zero question symbols in its generated
  surface — so `chat.question.reply` posts to a constant `/question/{id}/reply` or
  `/question/{id}/reject` path, the same technique the event shim already uses for `/event`.
  The route is a literal in the adapter and no part of it is chosen by the remote client, so
  this is not a step toward a generic API proxy.
- **Question text and option labels cross the boundary; nothing else does.** This is a
  deliberate, narrow exception to the no-tool-input rule, limited to what OpenCode itself
  prepared for display: the question, its short header, and each option's label and
  description. Tool input, command text, model output and native metadata remain excluded.
- **Everything is bounded and sanitized before it leaves the plugin.** `displayText` strips
  C0/C1 control characters and bidi overrides and truncates; the question caps at 2000
  characters, the header at 64, an option label at 80, a description at 256, and the option
  list at 32 entries. The protocol schema re-asserts every cap, so an over-long field is
  rejected rather than silently trimmed on the wire, and the Dart model asserts them a third
  time on arrival.
- **An answer is a set of option indices, never text.** `chat.question.reply` carries
  `selected` positions into the option list, or `reject`. The plugin resolves those indices
  to labels against the question it captured itself, so nothing the user types — and nothing
  a compromised client invents — reaches the agent as free text. Resolution doubles as the
  freshness check: a question already answered or replaced no longer resolves, and the reply
  fails with `context_expired`.
- **The reply is a mutation.** It joins the dispatcher's `mutations` set, so it inherits the
  request journal, retry deduplication and `uncertain_outcome` reporting.
- **The client opts in.** `includeQuestions` on the snapshot request and a `chat.questions`
  capability gate the whole feature, so a connector or client that does not implement it is
  unaffected.
- **Only the first pending question is forwarded.** OpenCode may ask several at once; the
  client answers one at a time, and a partially-answered batch would be ambiguous on
  reconnect.

## Threat Analysis

The question text is authored by the model, and a model can be steered by content it has
read — a prompt-injected repository file can shape what it asks. So this text must be
treated as hostile input that the product has chosen to display, in the same way a chat
reply already is.

What the caps and sanitization prevent is a question being used as a delivery mechanism.
Control characters and bidi overrides are stripped, so a label cannot reorder or disguise the
text around it, and an option reading "Reject" cannot be made to render as "Allow". Every
field is length-capped, so a question cannot flood the device or push the action buttons off
screen, and the option list is capped so a question cannot produce an unbounded control list.
The client renders all of it as plain `Text` — never markup, never a link — so there is no
tappable target inside agent-authored content and nothing that can navigate.

What the design does not claim is that a user cannot be socially engineered by a convincing
question. A question that says "select Approve to continue" is indistinguishable from a
legitimate one, and that is inherent to the feature: the product exists to relay the agent's
prompts. The mitigation is that answering a question grants nothing on its own — the answer
returns an option index, and any privileged action the agent then takes still passes through
the permission flow, which is a separate prompt with its own approval. A question cannot be
used to obtain a permission.

Index-based answers also bound what a compromised client can say. It cannot inject arbitrary
text into the agent's context through this path; it can only pick among options OpenCode
already wrote, or decline. The index is validated against the captured question, so an index
outside the option list is rejected rather than passed along.

The reply route is a constant. A remote client supplies a question id, which is
percent-encoded into a fixed path, and nothing else about the request is client-selected, so
this does not widen the remote surface to arbitrary OpenCode endpoints.

Capture is event-driven, which means a question asked while no subscription is live is not
seen until the next snapshot. That is the same limitation permissions have, and it fails
safe: an unseen question is an unanswered one, not a wrongly-answered one.

## Consequences

A question now reaches the phone with its choices, and answering it unblocks the agent.
Existing clients are unaffected because the capability and the snapshot opt-in are both new.

The no-tool-input rule now has a documented exception. It should stay a single exception:
anything else that wants to forward agent-authored text needs its own decision, not a
citation of this one.

Because only the first pending question is forwarded, a multi-question batch is answered one
prompt at a time across successive snapshots. If OpenCode starts asking batches routinely,
that should be revisited rather than worked around in the client.

The reply reaches OpenCode through a hand-written route rather than a generated client
method. If a future SDK exposes questions on the surface the plugin is handed, that call
should replace the literal path.

## Update: free-text answers

The original decision excluded free text as a deliberate, singular exception to the
no-tool-input rule. Two things revisited that:

- OpenCode's own question payload carries a `custom` flag (default true) that its TUI
  uses to offer a "type your own answer" entry alongside the fixed options, submitted
  through the same reply endpoint as an arbitrary string. This was not a remote-client
  invention to evaluate on its own merits; it is how OpenCode already expects a question
  to be answerable, and the remote client rendering fewer answer paths than the terminal
  does is itself a product gap -- part of what this ADR set out to close.
- `chat.prompt` already forwards whatever free text the user types, with no resolution
  against anything OpenCode prepared. A question's free-text answer carries the same
  risk profile: it reaches the agent as ordinary conversational input the model was
  already going to receive if the user had just typed a message instead of answering
  the question. Restricting only this one path did not reduce what a compromised or
  careless client could put in front of the agent.

The decision now: `chat.question.reply` accepts `text` in place of `selected`, gated by
the question's own `custom` flag (a question can still opt out, e.g. a strict yes/no).
The text is capped at 2000 characters -- the same bound as the question itself -- and
forwarded as-is, exactly as OpenCode's TUI already does. It is not sanitized beyond that
bound, matching `chat.prompt`'s own treatment of user-typed text.

What stays true from the original decision: an indexed answer still resolves only to a
label OpenCode itself supplied, so selecting an option can never assert text the model
didn't write, and answering still grants nothing on its own -- any privileged action the
agent takes afterward still passes through its own permission prompt. What changed is
narrower than it looks: OpenCode was always going to receive this exact text, either as
a question answer or as the next prompt: the only new thing on the wire is a label for a
request the agent was already reachable by.

## Update: multi-question batches

The original decision forwarded only `request.questions[0]`, on the reasoning that "the
client answers one at a time, and a partially-answered batch would be ambiguous on
reconnect." That tradeoff is revisited now that a client answers a whole batch at once
instead of one question at a time, which removes the ambiguity the original decision was
avoiding: nothing is ever sent until every question in the batch has an answer, so there
is no partially-answered state to reconnect into.

The whole ordered list in `request.questions` is now forwarded, capped at 8 entries -- a
small, generous bound on a native list, the same kind of cap this codebase already
applies elsewhere (e.g. subtasks). `ChatQuestion` is now a batch: one id shared by every
question in it, in OpenCode's own order. This was already latent in the v1 reply
endpoint this plugin targets: `POST /question/{id}/reply` has always accepted
`{ answers: string[][] }` -- "user answers in order of questions" -- and the plugin
already built that exact shape; it just always sent a single-element array. No new
OpenCode-side capability was needed, only the removal of the `[0]` truncation on both the
read and write paths.

`chat.question.reply` now carries `answers`, one entry per question in the batch, in
order, instead of a single `selected`/`text` pair. Each entry still resolves the same way
a single answer always did: `selected` indices resolve to labels against that entry's own
captured options, and `text` is only accepted for an entry whose own `custom` flag allows
it -- both checks are now per-entry rather than for "the" question, since a batch's
entries can differ in `multiple`/`custom` from each other. A short or long `answers` list
fails the same way an unresolvable question always has: `context_expired`, closed before
anything reaches OpenCode.

`reject` remains whole-batch: it declines every question in the pending request, with no
per-question form, because OpenCode's own reject endpoint has none either. A client
cannot decline part of a batch while answering the rest.

What did not change: index-based answers still resolve only to a label OpenCode itself
supplied, answering (or rejecting) a batch still grants nothing on its own, and the reply
still goes through the same fixed-route transport this ADR already established. See
`CHAT-QUESTIONS.md` for the current wire contract.

## Update: a persisted asked/answered record

Once a batch was answered, the live banner disappeared and nothing took its place: the
completed `question` tool call rendered as an ordinary tool bubble, but fell through
`toolSummary`'s generic fallback (no native tool name recognized it) and showed only the
bare word "Question" -- no question text, no options, no chosen answer. Scrolling back
through a chat gave no record of what had been asked or decided.

The fix stays inside this ADR's own boundary: only what OpenCode itself prepared for
display, or what the plugin itself resolved, ever crosses into a tool description --
never OpenCode's native tool output or metadata for a completed `question` call, which
this plugin has never confirmed the shape of (unlike everything else this ADR relies on,
which is confirmed via strings on the binary or live event capture).

- **The "asked" half needs no new trust.** A `question` tool part's own `state.input` is
  `{ questions: Prompt[] }` -- the tool's own declared parameter schema, the exact same
  shape already sanitized for the live banner. The per-item sanitize/cap logic was
  factored out of `questionSummary` into a shared `sanitizeQuestionPrompts` helper so the
  live banner and a completed tool part's description apply identical bounds.
- **The "answered" half is the plugin's own record, never OpenCode's.** At the moment
  `chat.question.reply` succeeds, the plugin already knows exactly what it resolved
  (the same labels/text it just sent) -- that resolution is remembered, not re-derived
  from anything OpenCode returns afterward.
- **Correlation is by sanitized content, not a native id.** The pinned v1
  `question.asked` payload this plugin targets has no confirmed field linking a request
  id to the tool call's own part/callID (unlike permissions, whose SDK-declared type does
  carry one). A completed tool part is matched against the remembered record by comparing
  its own sanitized `questions` for equality, not by id. A collision would require two
  distinct question calls in the same session asking byte-identical text -- cosmetically
  odd in that vanishingly rare case, never a trust issue, since either side of a
  collision only ever shows real content the plugin itself already sanitized.
- **No new part shape.** The combined summary (`"Header: Answer · Header: Answer"`, or
  just headers when nothing resolved yet) is bounded and sanitized the same way every
  other tool description is (256 characters, control characters and bidi overrides
  stripped) and fills the existing `description` field a `question`-operation tool part
  now carries, rendered by the existing generic tool row. A free-text answer is
  re-sanitized here even though it was already bounded at reply time, because it was
  forwarded to OpenCode as the user typed it (see "Update: free-text answers" above) and
  had never itself passed through control-character/bidi stripping.
- **The record is process-lifetime only, not durable.** It lives in a small map on the
  adapter, keyed by session id (not by live subscription, so it survives a reconnect,
  unlike the pending-question capture itself) -- capped at 20 answered batches per
  session and 200 sessions total, oldest evicted first. An OpenCode/plugin restart loses
  it, same as the accepted, documented limitation this ADR already carries for live-only
  permission capture: an unrecoverable record is a missing description, never a wrong
  one.
