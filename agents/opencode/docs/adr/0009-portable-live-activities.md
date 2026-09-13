# ADR 0009: Agent-neutral activities and bounded live updates

Status: Accepted

## Context

Snapshot polling missed short-running activities and provider text emitted before
completion. Shell, tool and thought headers also used different typography, and
there was no shared running indicator. Future connectors such as Pi should reuse
the mobile presentation without exposing host SDK types.

## Decision

Define the vocabulary in a language-neutral activity schema, generating identifiers
for TypeScript and Dart. Keep native name/event mapping in each agent adapter and
the visual registry in mobile. Deliver negotiated encrypted subscriptions with
revisioned replacement messages, snapshots for reconciliation, and bounded source
text overlays where the pinned runtime persists text only at completion.

Use a single visibility/lifecycle-gated animation clock and isolated icon repaint.
Shells start collapsed with description-based headers. This supersedes the initial
expanded/default generic-header presentation in ADR 0008.

The [activity contract](../../../../protocol/ACTIVITY.md) defines limits, source
compatibility, field handling, failures, energy safeguards and the threat analysis.

## Consequences

New/old peers negotiate features independently. Pi can map to the same vocabulary
later without importing OpenCode types or adding provider-specific Flutter UI.
Transient buffers remain bounded and local; the relay stays opaque and stateless
for chat content. A missing pre-subscription text prefix is explicitly incomplete
until a complete source update, rather than requiring server-side token storage.
Physical-device profiling is required before making measured energy claims.
