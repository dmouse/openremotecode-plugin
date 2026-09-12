# Agent activities and live conversations v1

## Ownership and portability

`schema/activity-v1.schema.json` is the language-neutral source of activity kinds
and states. `scripts/generate-activity.mjs` generates the TypeScript and Dart
identifiers; `--check` runs in protocol tests to detect drift. Regenerate with
`node packages/protocol/scripts/generate-activity.mjs` from the repository root.
Shared examples live in `test/fixtures/activity-v1.json`.

Kinds: reasoning, read, write, edit, apply_patch, search, list, execute, fetch,
update_tasks, subtask, tool. States: pending, running, completed, failed,
cancelled, unknown. Network availability is independent of execution state.
No state is inferred from a display description or provider name.

Adapters map their host's tools/events to these kinds. OpenCode's mapping is in
`packages/agents/opencode/src/activity-adapter.ts`; `bash`, `todowrite`, and
`apply_patch` become execute, update_tasks, and apply_patch. Unknown actions become
tool. A future Pi adapter can map its message_update and tool_execution_* events
to the same contract. This change does not install or implement a Pi connector.
Each host remains authoritative for its conversations; activities are metadata
on existing message parts, not a second conversation store.

Mobile owns labels, icons and typography in `activity_presentation.dart`, and
rendering in `ActivityRow`. Protocol fields never contain Flutter icon IDs or
font configuration. New native tools can use an existing kind/generic fallback
without changing mobile. New protocol kinds require version/capability negotiation.

## Activity negotiation

Connectors advertise `chat.activities`; clients opt into `includeActivities: true`
on ordinary/child snapshots and live subscriptions. Non-text parts can then carry
`activity: { kind, state }`. Other presentation fields and size limits remain in
their existing contracts. Reasoning content requires the host to actually supply
it. Missing timestamps/state never invent a duration or successful completion.
Older clients receive the existing parts without activity metadata.

## Live subscriptions

Separate capabilities/operations:

- `chat.stream.subscribe`: version, projectId, sessionId, subscriptionId (UUID),
  optional parentSessionId and the existing presentation opt-ins.
- `chat.stream.unsubscribe`: the same target IDs, without presentation flags.
- `chat.stream.updated`: non-callable event marker.
- `chat.stream.closed`: non-callable event marker for loss/expiry of a source stream.

Subscribe responses and updates contain the target IDs, a nonnegative safe
`revision`, `reset`, and `snapshot`. The first response is a complete latest page;
updates contain **replacement messages that changed**, plus current chat/status
metadata, using the existing snapshot shape. Text is cumulative within each
replacement; mobile must not append it again. An empty messages array can update
status alone. A renew response is another complete latest-page baseline. A reset
event reconciles deletion/compaction by replacing retained history with its page.
Event requestId equals subscriptionId. Closed events contain only version/target
IDs, with no native error or content.
Updates/baselines carry an optional `resetRevision` watermark after a deletion or
compaction. A baseline that overtakes its reset event must still clear retained
history if that watermark exceeds the client's applied revision; it must not
resurrect deleted messages by merging the baseline into stale history.

The source listener is established before acknowledging the initial baseline.
OpenCode updates are coalesced over 100ms with at most one read/send per
subscription. Live text/reasoning is projected from bounded cached parts after
fresh workspace/session authorization checks, without rereading message history,
status or subtask histories for each delta. Initial snapshots, structural changes,
renewals and final reconciliation still use authoritative SDK reads. Terminal
events publish their final live content before scheduling reconciliation. Only
changed messages cross the encrypted relay; idle streams do not repeatedly read
or send snapshots.

OpenCode 1.18.30 does not expose all in-flight provider text through its persisted
message reads. `LiveParts` therefore retains only bounded text/reasoning fields
from part updates/deltas, overlays them on membership-checked SDK snapshots, and
replaces them with complete source updates. Unknown delta fields are ignored;
synthetic/ignored text stays filtered. No raw event is exposed remotely.

The `session.next.step.*`, `session.next.reasoning.*` and `session.next.text.*`
family is normalized explicitly as well. Start creates a running activity even
with empty text or missing clocks; deltas update the same scoped message/block;
end/failure terminates the activity. Provider-local block IDs are hashed together
with message ID and kind, preventing collisions across messages. Next-engine
parts own their text/reasoning kind when both event families are emitted, so
text is not appended twice. Final persisted messages supersede transient parts.
Only IDs, lifecycle state, bounded text and valid clocks are retained; next-engine
provider metadata and raw errors are excluded.

The two native history stores are read through fixed, scoped SDK routes and merged
into ten-message pages. Internal cursor state retains only native cursors and
unconsumed message IDs, never message content. Pending IDs anchor partial pages
while new messages arrive. Next-engine system/synthetic/configuration records
produce empty presentation entries, and next-engine tools pass through the same
explicit projection as legacy tools. Every page is checked for project/session
membership before and after reading. This preserves streamed next-engine replies
after refresh/reconnect instead of querying only the legacy store.

The root SDK's `event.subscribe` helper in 1.18.30 bypasses its configured fetch
transport. The embedded TUI supplies an in-process fetch, so that helper can fail
even while snapshots work. `opencode-events.ts` instead opens the fixed `/event`
route using the SDK's ordinary GET transport with `parseAs: stream`. This preserves
injected fetch, authentication, request interceptors and canonical directory scope.
The SSE parser bounds each frame to 1,000,000 characters, supports LF/CRLF and
multi-line data, and cancels its reader on teardown. Malformed source data emits
only a fixed failure. No global fetch patch, new public listener or client-selected
URL is introduced. A regression with global fetch disabled covers the embedded path.

If attaching mid-generation leaves a prefix unavailable, `message.incomplete:
true` labels the temporary content until a full source update arrives. Mobile
shows a waiting-for-complete-response notice rather than silently representing
the suffix as a complete answer. The server does not replay or store token history.

Limits: two subscriptions, two outstanding reads and two source watchers per
reader across relay lifetimes; ten-second startup/read deadlines; sixty-second
leases renewed by visible clients after twenty-five seconds. During an existing
read/send, renewal returns the last authorized baseline instead of queuing work.
Read reservations last until actual SDK settlement, even after cancellation.
The legacy live-text cache retains at most 1,000 parts and 480,000 UTF-16 units;
the next-engine cache is independently bounded to ten messages, 100 blocks per
message and 480,000 units. Each part is capped at 48,001 units to preserve the
existing truncation signal. Previously persisted messages outside the latest
page are evicted from caches instead of being re-appended as new live messages.
All message, page, encryption/frame, queue, and mobile 200-message limits apply.

Mobile buffers at most four out-of-order updates. It applies only contiguous
revisions, ignores duplicates/older baselines, and restarts via a fresh snapshot
after a gap (500ms), invalid data, closure, or peer-generation change. Events
cannot resolve pending requests. The initial stream is ready before submitting
a new draft's first prompt; accepted prompts keep an existing live subscription.
Legacy connectors retain three-second snapshot polling. Poll timers and leases
stop for inactive/covered chats, and return navigation reconciles a new snapshot.

## Presentation and energy budget

- All activity headers share Thought typography: 12px, 1.35 line height, the
  normal UI font; secondary status/timing is 11px. Icons/spinners match the 12px
  header size and scale with accessibility text, centered on its first line.
  The gutter is the scaled icon width plus 8px. Shell headers share the compact
  32px minimum row height and 4px vertical padding of thoughts/tools; the entire
  width is tappable. Navigable subtasks retain 48px targets. Code/output bodies
  retain selectable monospace text.
- Shell details start closed. The header uses a bounded first-line description
  (100 graphemes), falling back to Run command. Collapsing hides command/output
  from both visible and accessibility trees, while retaining the description.
- Running activities use one shared spinner clock. Only visible running glyphs
  subscribe to its repaint notifications. Completed icons have no animation
  layers. No message/Markdown rebuild occurs on a spinner frame.
- Thinking state is separate from permission to animate: a known running thought
  is labeled Thinking even if aggregate busy status lags. When its live connection
  is unavailable, it is labeled last known with a static indicator, not falsely
  labeled as a completed Thought. Completed/failed states come from lifecycle data.
- A compact three-dot footer remains at the newest end of the conversation during
  submission and overall agent work, including between thought/tool blocks. It
  shares the same clock and visibility gates; reduced motion shows static dots.
  Screen readers hear a single Sending message/Agent is working label. Visible
  message anchors keep older history stationary when the footer appears/disappears.
- Cached off-screen glyphs are checked on layout/scroll changes, not on every
  animation tick. The clock stops when none are visible, on backgrounding,
  covered routes, TickerMode disablement, or reduced motion. Reduced motion uses
  a static running glyph and explicit state text. No elapsed-time row timers,
  shimmer, whole-row pulsing, or simulated typing animation is used.
- Live text is rendered in batches; unchanged Markdown widgets are cached.
  Bottom-following readers stay at the bottom. Reading older content does not
  force an automatic jump to the newest response.

Unit tests assert a single clock for concurrent activities, no title rebuilds
during animation, and zero animation callbacks when off-screen, completed,
disabled, backgrounded or reduced-motion. Native tests exercise real OpenCode
SSE/provider deltas and Android encrypted updates. Emulator/debug results are
not a battery measurement: frame/CPU/network and energy comparisons still need
profile-mode runs on representative physical devices before release claims.

## Threat analysis and failures

The adapter revalidates project/session membership, child-parent membership and
canonical workspace identity before and after each read. Source events are hints,
not authorization. All replacements use the same explicit presentation projection
as snapshots; only opted-in shell text crosses the expanded shell boundary.
Untrusted senders, tampering, replay, wrong recipients and revoked identities
continue to fail through existing authenticated relay admission/HPKE checks.
Subscriptions and late responses are bound to the admitted connection generation.

Source loss, authorization failure, malformed/over-budget data and expired leases
close the subscription with fixed metadata only. Saturation disconnects through
the existing relay bound. No prompts, outputs, raw events, errors or cache content
are logged, audited, persisted by the server, or written to mobile disk. Timing
metrics remain content-free. Cancellation stops source listeners and drops
temporary buffers; the local agent remains authoritative after reconnect.
