# OpenCode 2 Support: TUI-Hosted Connector

Status: accepted (eighth milestone: activities and images; todos found unsupportable)

OpenCode 2.0.x replaced the plugin contract. A v1 plugin is a function returning hooks; a v2
plugin default-exports `{ id, setup(context) }`. OpenCode 2.0.12 rejected this package's
function export with `Plugin must export a default definition with an id and an effect or setup
function` (`SchemaError: Expected object at ["default"]`).

## Decision

One package serves both generations. Each entry's default export is an object carrying both
shapes: `dist/index.js` is `{ id, server, setup }` and `dist/tui.js` is `{ id, tui, setup }`. v1
reads `server` / `tui` and ignores the unknown `setup` key (verified on 1.18.31); v2 reads
`setup`. The shared lifecycle (identity, pairing, relay, ownership lock) is `src/connector.ts`,
taking a small host interface (`log`, `notify`, `adapters`), so the v1 and v2 entries differ only
in how they supply those.

On v2 the connector runs in the **TUI plugin**, not the server plugin. The v2 server plugin
context is deliberately narrow: `ctx.session` has only `create/get/prompt/interrupt/update/move/
wait/context` (no listing, no message history, no forms, no status), and it exposes neither the
server URL nor credentials. The TUI plugin context carries the complete v2 client and a toast
surface for the pairing code. Reading the server URL and password out of OpenCode's own files to
widen the server plugin's reach was rejected: it would exceed the access the API grants and
conflicts with least privilege.

The v2 server-side `setup` is inert. The TUI entry keeps the v1 OpenTUI interface behind a lazy
import so a v2 TUI never resolves it.

## Consequences and limits

- The phone can reach a v2 instance only **while a TUI is attached to it**. A headless
  `opencode serve` on v2 has no connector. v1 is unchanged.
- The v2 adapter (`src/v2/`) implements `project.list`, `project.open`, `chat.list`,
  `chat.create`, `chat.get`, `chat.snapshot`/`chat.subtask.snapshot` (with the `chat.tools`,
  `chat.shell`, `chat.questions`, `chat.activities`, `chat.images` and `includeSubtasks`
  opt-ins), `chat.models`, `chat.stream.subscribe`/`chat.stream.unsubscribe`, `chat.prompt`
  (text only), `chat.abort`, `chat.permission.reply` and `chat.question.reply`. The connector
  advertises exactly that set. Everything else, including todos, rename/fork/delete and project
  MCP status, fails as `unsupported_operation`. `mode` and `model` on a prompt are refused rather
  than silently dropped.

### Activities and images

Both reuse existing v1 presentation code unchanged, the same pattern as tools/shell: `activityFor`
(`src/activity-adapter.ts`) already operates purely on the normalized `Part` shape
`convertNextMessage` produces for every v2 tool -- including the "streaming"→"running" status
mapping tools/shell already needed -- so a v2 tool call's live activity state (running, completed,
failed, or abandoned once the session has settled) needed no new code at all.

Images needed one real fix: v2 attaches a user file as `{data: base64, mime, source:
{type:"inline"|"uri"}}`, not v1's single `data:` URI. `message-history.ts`'s converter now
reconstructs that URI (`data:${mime};base64,${data}`) from the real bytes and mime type instead of
its previous placeholder (`mime:"text/plain", url:""`, which meant no v2 image ever actually
decoded). A `"uri"`-sourced attachment, which carries no inline bytes here, still degrades to a
plain filename label -- the same fallback a non-image or oversized file already uses -- rather
than a broken link.

`sessionSettled` (which decides whether an interrupted tool call reads as abandoned rather than
stuck running forever, see ADR 0012) is computed more conservatively for v2 than v1's own
condition: v1 treats a live subscription's continuously event-captured pending state as enough on
its own, even without this particular request opting into permissions/questions, because a
`LiveParts` overlay keeps that state accurate regardless. v2 has no such overlay, so "nothing
pending" only counts when *this* request actually asked about both permissions and questions;
otherwise it may just mean "never checked", and a part must not be presented as abandoned on that
weaker basis.

**Fully verified live**: a real inline PNG (decoded, resized and re-encoded through the same
`sharp` pipeline v1 uses, mime and non-empty output confirmed) and a real completed tool call's
activity state, both read back over the encrypted relay only when the client opts in.

### Subtasks

`src/v2/subtasks.ts` resolves a `task` (subagent) tool call's linked child session the same way
v1 does (`src/chat/subtasks.ts`): read the child's own recent history, compute stats, and degrade
to the tool's own reported status -- never discarding the parent chat -- when the child is
missing, foreign, or not yet linked. Everything that reads a resolved subtask's content reuses
v1's unchanged presentation functions (`subtaskSummary`, `subtaskStats`); both already operate on
the normalized `Part`/message shape `convertNextMessage` produces for every v2 tool, so no new
presentation code was needed, only a v2-specific way to fetch and validate the child.

Unlike questions, v2 introduced no new dedicated API for this: the same task-tool-plus-`parentID`
mechanism v1 relies on is believed to still exist unchanged, since there was nothing to swap it
for. The tool is still literally named `"task"`, `state.metadata.sessionId` is preserved verbatim
by the same converter fix tools/shell already needed (it never touches unrecognized metadata
keys), and `SessionInfo.parentID`/`fork` already existed in the real v2 schema for unrelated
reasons (a plain fork). The risk here is narrower than questions': only the metadata field name
and the tool name are assumed, not a whole mechanism swap.

**Fully verified live**, using `session.import` to fabricate a linked parent/child pair (a
completed `task` tool call, and a separate session with `parentID` pointing at the parent) since
this environment cannot run a real subagent call: the child resolves correctly through
`chat.snapshot`'s `includeSubtasks` opt-in, with real stats computed from the child's actual
message history; `chat.subtask.snapshot` views the child directly, and only through its true
claimed parent (a wrong claimed parent, or a session with no parent at all, is `access_denied`).
Degradation was verified too: a task pointing at a missing or foreign session, or one with no
child id yet, keeps the parent chat intact and shows the tool's own reported status rather than
crashing or discarding anything. What is not verified is whether a real subagent call actually
produces this exact linkage -- same caveat as questions, same reason (no live model).

### Todos: no v2 API surface found

Unlike questions and subtasks, todos have no discoverable v2 mechanism to build on, tentative or
otherwise. v1's `GET /session/{id}/todo` has no v2 counterpart: it does not appear anywhere in
v2's OpenAPI spec, and searching the real binary's strings for `todowrite`, `todo.write`, or a
`"todos"` field (the shape v1's own todo item takes) found nothing resembling the tool or its
data, only unrelated matches from the JS test runner bundled in the same binary. This is an
absence, not an unconfirmed inference, so `includeTodos` stays refused rather than attempted.

### Questions

v2 has no dedicated question API. ADR 0011 (v1's question design) explicitly warns that its
tool-input-forwarding exception "should stay a single exception... anything else that wants to
forward agent-authored text needs its own decision, not a citation of this one" -- so this section
is that decision for v2, made deliberately rather than by extension.

**What v2 is believed to do, and what is actually confirmed.** OpenCode's own "question" tool is
still literally named `"question"` (confirmed: `strings` on the real binary shows a renderer
reading `t.input.questions`/`t.metadata.answers`, the same shape v1's tool state already uses).
How it *asks* changed: v2 replaced the old dedicated question mechanism with a general-purpose
Form API (`session.form.*`: typed fields -- string/number/integer/boolean/multiselect/external,
conditional visibility, validation constraints -- richer than a batch of multiple-choice
questions). A synthetic test-session simulator found in the same binary's strings shows a
`kind === "question"` form being answered by mapping `answer[field.key]` back into the tool's
`metadata.answers`, one field per question -- consistent with, but not proof of, how the real
question tool behaves, since this environment has no working model provider to observe a real
tool call. This is a materially different confidence level from every other v2 gap in this
document: those were verified end-to-end against the real server; this one relies on inference
from code built to exercise UI rendering paths, not the production tool itself.

**The design deliberately does not depend on that inference for content.** A pending question's
displayable content (question text, option labels) is read entirely from the Form's own fields
(`session.form.list`), not from any tool state, and a form is recognized as an answerable
question batch only when *every* field independently qualifies: type `multiselect` or `string`,
a non-empty fixed `options` list, a non-empty `title`, not `hidden`, and no `when` conditions. Any
field outside that shape voids the whole form -- it is not surfaced as a question at all, the same
fail-safe-by-omission the codebase already uses for an unrecognized permission or tool, never a
guess at what it might mean. This makes the feature's correctness independent of whether the
"kind === question" inference is right: whatever creates a question-shaped form, recognized or
not, is handled the same way.

**Reply resolves to the form's own stable option `value`, not the display `label`.** Unlike v1
(whose native reply has no value/label distinction and sends the label itself), v2's `FormOption`
separates a stable `value` from a cosmetic `label`; submitting `value` is the conventional,
schema-intended choice absent contrary evidence, and was chosen over the alternative (submit the
label, mirroring v1) precisely because it is the more defensible default when the real consumer's
expectation isn't confirmed either way.

**A field's free-text default is resolved as `false`, not v1's confirmed-`true` default.** v1's
tool schema is documented to default `custom` to allowed; v2's Form field schema declares `custom`
as an optional boolean with no confirmed default. Where v1 has a confirmed permissive default,
v2's is treated as denied unless the field says otherwise -- the safer direction for an unverified
default, since it fails toward less reaching the agent, not more.

**What is fully tested, live, against the real 2.0.12 server** (not synthetic-harness inference):
creating a form, listing only pending forms, recognizing/rejecting one by field shape, replying
(index-based and free-text, with the exact submitted `value`s and shell-independent removal from
the pending list confirmed via `session.form.get` afterward), rejecting/cancelling, and a stale or
already-answered form's reply failing as `context_expired`. What is *not* tested is whether a real
model-driven question tool call actually produces a form recognizable by these rules -- that
needs a live model, which this environment does not have.
- Tool and shell content reuses v1's `chatMessageContent` unchanged: `message-history.ts`'s
  converter already turned v2's assistant `content` array into the same `Part` shape v1's own
  history uses (built earlier for the "next" engine, v2's internal predecessor), so v1's own
  read/write/edit/search/bash presentation, description derivation and bounding needed no v2
  counterpart at all -- only the converter's tool-state mapping needed fixing (below). A `task`
  (subagent) tool call falls through to a generic bounded summary, since `includeSubtasks` stays
  unsupported.
- **Two real bugs the converter had for v2, caught by testing against the actual types, not by
  reading them:** (1) v2 adds a `"streaming"` tool status (partial, not-yet-parsed JSON input)
  that the pinned status enum has no slot for and would have thrown on; it is treated as
  `"running"`. (2) the converter unconditionally replaced a tool's real `metadata` with a
  synthesized `{ output }`, which for a `running` or `error` state (v2 gives no `content` array
  until completion) silently discarded whatever OpenCode itself already published there --
  including a live shell's own in-progress output and any `truncated` flag -- and replaced it
  with an empty one. It now derives `output` only from a completed/error state's real `content`
  and otherwise preserves OpenCode's own `metadata` untouched.
- `chat.models` (`src/v2/models.ts`) sources its list from `model.list()`, not `provider.list()`:
  v2 has no single call that nests models under their provider the way v1's `config.providers()`
  did, and `provider.list()` only shows providers with a stored, credentialed connection --
  the built-in "opencode" zen catalog (usable with no configuration at all) never appears there,
  so relying on it would have hidden every model a fresh install can actually use. Each distinct
  provider's display name is a separate, bounded `provider.get()` lookup; a provider that fails to
  resolve is shown by its own id rather than dropping its models, since the name is display-only
  and prompting still goes through OpenCode's own validation regardless.
- **Real-server-only bug caught by testing, not by reading types:** a directory-scoped
  `model.list()` answers empty until that location has been resolved at least once. Neither
  omitting `location` nor calling `session.list` first does this; only `client.location.get(...)`
  does, confirmed by testing all three against a real 2.0.12 server. `chat.models` calls it before
  every `model.list()`. Prompt-time model or agent selection is not implemented in this milestone:
  v2 has no per-prompt model override at all (`SessionPromptInput` carries no `model` field);
  the equivalent is `session.switchModel`/`session.switchAgent`, which persist for the whole
  session rather than one turn -- a real semantic mismatch with v1's `chat.prompt.model`, not
  just a missing field, so it stays refused pending its own design.
- Streaming reuses `ChatStreams` (`src/chat-stream.ts`) unchanged: it is already generic over a
  `ChatStreamReader` (`readChat`/`watchChat`), so it needed no v2-specific code. The v2 adapter
  implements that interface directly. Unlike v1, whose root SDK client cannot reach the embedded
  server and needs a raw SSE re-fetch (`opencode-events.ts`), the v2 client the TUI is given
  already exposes a typed `event.subscribe()` async iterable (`src/v2/event-source.ts`), so no
  transport shim was needed.
- `watchChat` verifies session membership once, then treats every event carrying the target's
  `sessionID` as "changed" and re-reads a fresh `chat.snapshot` -- no per-part live overlay
  (no `LiveParts` equivalent) in this milestone, since `chat.snapshot` itself does not project
  streaming deltas yet. `ChatStreams`' own diffing and 100ms coalescing already batch a burst of
  events into one update. `server.connected` unblocks the caller's first read the same way v1's
  does; `location.shutdown` is v2's counterpart to v1's `server.instance.disposed` and ends the
  stream as fatal. A subtask target (`parentSessionId` set) is refused as unsupported before any
  event is read.
- Snapshots read OpenCode 2's own history through the same presentation layer the v1 adapter
  uses (`convertNextMessage`, `chatMessageContent`), newest page first (ten messages), older
  pages through an opaque, session-bound cursor. Only user and assistant messages are chat
  content; agent/model/location switches, system, skill, compaction, idle and message kinds this
  build has never seen are skipped before parsing, so a newer server cannot break history.
  OpenCode 2.0 gives assistant text and reasoning content no id, so part ids fall back to
  position in the message, and the assistant's `agent` is read as its mode.
- The v2 permission action names may differ from v1's tool names; an unrecognised action is shown
  with the generic "Permission requested" description rather than as a specific operation.
- A snapshot still shows only what OpenCode has stored (`chat.snapshot` has no in-progress text
  or reasoning content), so a running reply is invisible until it completes and a stream update
  fires. A busy session is reported as `busy`.
- I could not reproduce a real pending (`ask`-effect) permission through the v2 API in this
  environment: `permission.create` returned `deny` even with a matching `{action:"*",
  resource:"*", effect:"ask"}` config rule, seemingly because it needs a real in-flight tool call
  context this environment has no model access to create. `permission.asked`/`permission.replied`
  are implemented against the documented event schema but not exercised live.
- Questions carry the same limitation, more sharply: not just an event schema, but the whole
  premise that a real question tool call produces a form recognizable by this milestone's rules,
  is unconfirmed against a live model. See "Questions" above.
- Subtasks carry the analogous limitation: the task-tool-to-child linkage is fully exercised via
  a fabricated linked pair, but never against a real subagent call. See "Subtasks" above.
- Activities and images carry no comparable uncertainty: both are presentation-only, verified end
  to end with real image bytes and a real tool call, and depend on no inferred v2 mechanism the
  way questions and subtasks do.
- Tool and shell content is verified end to end against a real 2.0.12 server using
  `session.import` to seed synthetic completed tool calls (as data, not a live model), since this
  environment has no working model provider to run a real agent turn. The exact field names a
  real running (in-progress) v2 tool call publishes under `metadata` -- for example whether a
  live shell really uses `metadata.output` -- are therefore unverified; the fallback above is
  written to degrade safely (show nothing extra) if it does not.
- Not yet verified: the v2 `setup` inside a real interactive TUI (no TTY was available). It is
  verified against the real v2 server and the real v2 client, and the built package is verified
  to load in the real v2 loader as active with `server` and `tui` features.
- Missing-session errors from the v2 client are plain tagged objects
  (`{ _tag: "SessionNotFoundError" }`), not `Error` instances, and its `next` cursor is present
  on the last page. The adapter handles both; each is covered by a test.
- The v2 TUI has no plugin log sink. Diagnostics below error level are dropped and errors are
  shown once as a toast. The connector's rule against sensitive content in any log line is
  unchanged.

## Threat analysis

No new trust boundary. Sessions are still authorized against the canonical workspace directory
(realpath) on every operation, and subtask sessions are unreachable directly. Permission replies
pass `once`/`always`/`reject` through unchanged and only as the explicit per-request choice. The
remote client never chooses a method or route: every v2 call is a fixed call site behind the
`V2Client` interface, and each response is parsed as untrusted input. The plugin adds no
dependency on a v2 package, and uses the client OpenCode already connected, so no credential is
read from disk.
