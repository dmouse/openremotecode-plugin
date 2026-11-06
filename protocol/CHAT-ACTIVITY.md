# Chat list activity, viewed acknowledgments and live metadata (v1)

`chatSummarySchema` optionally carries `activity`: `status` (idle, busy, retry,
unknown), `idleAt`, `viewedAt`, and `outcome` (succeeded, failed, interrupted).
Clocks are nonnegative safe integer milliseconds. Absence is unknown, not read.
OpenCode's active-session map determines status; native idle/viewed timestamps
and outcome determine unread success. Titles, renames and generic updatedAt
changes are never used as read receipts. Summaries in latest snapshots carry the
same metadata. Old connectors remain readable without fabricated indicators.

`chat.view` is a negotiated mutation:

```json
{"version":1,"projectId":"11111111-1111-4111-8111-111111111111","sessionId":"session","idleAt":300}
```

It returns `{version:1,accepted:true}`. The adapter verifies folder approval and
root-session ownership (including the existing moved-session policy), rejects
future idle clocks or sessions without a completion clock, and calls the host client's `session.view` with
exactly that idle timestamp. The native method marks only that transition; an
old acknowledgment cannot clear a later completion. No timestamp means no
acknowledgment. Capability advertisement requires a supplied native view method;
missing methods fail explicitly. The operation is journaled like other mutations
and never retries automatically after uncertainty. Viewing is not a permission
reply, execution action, message mutation or arbitrary API proxy.

## Live list leases

`chat.list.subscribe` and `chat.list.unsubscribe` take only version 1,
subscriptionId (UUID), and 1–100 distinct approved projectIds. One subscription
per authenticated client covers its folders. Subscribe/renew returns those
fields plus a nonnegative revision; unsubscribe returns
`{version:1,unsubscribed:true}`. A subscription acknowledgment reserves the
watcher; only its authorized reset event establishes readiness for a fresh list.

`chat.list.updated` events use the subscriptionId as requestId and contain the
same target, monotonically increasing revision, reset boolean and at most 50
`{projectId,chat}` summary replacements. No raw events or message bodies are
included. A reset instructs the client to reload authoritative lists. Initial
connection markers, a known deletion, event overflow or a revision gap require
reconciliation; events are live-only, never replayed history. Unknown/new session
summaries trigger discovery rather than creating an unbounded mobile index.

Leases last 60 seconds; mobile renews at 25 and retires local liveness at 50.
`chat.list.closed` carries the target only. Stop/unsubscribe, revocation, failure,
expiry, relay disposal and send saturation abort the watcher. Updates coalesce
behind 150 ms with at most 50 pending session IDs, one serialized read/send per
lease, and two underlying watchers and reads per adapter across relay replacement.
Uncooperative cancellation retains its reservation until actual settlement.

Only relevant lifecycle/status/view events schedule reads. Session IDs are local
invalidation hints, never authorization: native get, pinned folder identity,
root-only checks and current approval are revalidated before emitting summaries.
A cross-process approval monitor also closes idle subscriptions. No per-session
message subscription, message fetch or model call is needed for the list.

Mobile applies updates only to their authenticated connector, generation and
negotiated project scope. Events can overtake acknowledgments. Read baselines
cannot erase newer in-flight list updates; a bounded overlay reapplies them
after refresh/pagination. Closing the app, trust loss and logout discard state.
Draft text never crosses this contract: it stays in workspace-scoped mobile memory.

## Verification

Both languages consume `test/fixtures/chat-activity-v1.json`. Tests cover invalid
clocks/states, legacy summaries, cross-folder identities, foreign sessions,
explicit view clocks, journal reuse, coalescing, backpressure, lease expiry,
generation rejection, uncertain acknowledgments and native encrypted relay flow.
OpenCode 2.0.12 remains the minimum compatibility target; newer viewed/outcome
metadata is used only when present. Native viewed behavior is verified separately
against OpenCode 2.2.5 with a matching generated client and isolated test storage.
