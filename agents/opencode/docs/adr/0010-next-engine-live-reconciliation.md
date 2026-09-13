# ADR 0010: Next-engine lifecycle and low-latency live delivery

Status: Accepted

## Context

OpenCode 1.18.30 can emit `session.next` events rather than legacy part deltas and
persist their messages in a separate native store. Refreshing only legacy history
missed in-flight reasoning and final next-engine messages. Full snapshot/subtask
enrichment on each live update also added avoidable delay before publication.

## Decision

Normalize next step, reasoning and text lifecycle events into the existing
agent-neutral activity contract. Use scoped block IDs, explicit running/end state,
bounded caches and authoritative final reconciliation. Live text delivery checks
authorization but uses cached normalized message parts instead of rereading full
history. Structural changes and baseline/final reconciliation read both native
stores through fixed SDK routes, with bounded merged pagination.

Mobile separates known execution state from animation eligibility, and uses one
visibility/lifecycle-gated clock for thought spinners and the three-dot working
footer. No typewriter simulation or independent per-dot timers are introduced.

## Threat and compatibility implications

See [ACTIVITY.md](../../../../protocol/ACTIVITY.md) for the complete limits and
failure model. Both native stores remain scoped to an independently verified
project/session; cursor state contains only native cursors and pending IDs. Native
provider metadata, system/synthetic content and non-allowlisted tool payloads stay
out of the protocol. Live messages are never persisted by the relay or client.
Existing protocol versions, opt-ins, replay checks and account isolation remain.

Tests cover actual legacy/next runtime events, message persistence, mixed-store
pagination, lack of history reads on text deltas, and immediate Thinking state
without clocks or a busy aggregate snapshot. Android covers actual next-engine
reasoning and the shared spinner/dot animation path.
