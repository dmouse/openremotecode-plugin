# 0020: Authoritative list activity and scoped viewed acknowledgments

Status: accepted, 2026-11-06.

Chat rows need working state, unread successful completion and device-local
draft indicators without loading every conversation. Keep OpenCode authoritative
for execution/outcome/viewed state and mobile authoritative only for its local
unsent drafts. Use an optional normalized activity summary, a metadata-only
list lease and a narrow `chat.view` mutation. Details and limits are in
[CHAT-ACTIVITY.md](../../../../protocol/CHAT-ACTIVITY.md).

## Threat analysis

- A client can name only existing approved project handles and root sessions.
  Native events are invalidation hints: their IDs, directories and metadata
  never grant access. Every returned change rechecks folder identity, ownership
  and approval; children and foreign roots are excluded. Moved roots reuse the
  existing session-specific continuity policy without granting their destination.
- Viewed state is an intentional, account-authorized UI mutation, not a trust
  grant. It cannot change messages, prompts, permissions, credentials or agent
  configuration. The adapter refuses future idle timestamps, forwards the exact
  observed clock and journals request IDs. A malicious authorized client can
  dismiss an existing completion, which is inherent in its authorized viewing
  capability, but cannot acknowledge a not-yet-existing completion.
- Revocation during a read drops the result; idle revocation stops the watcher.
  Stop/expiry/relay disposal abort pending sends. Reads and watchers have shared
  resource reservations across relay replacement; bursts collapse to a reset
  instead of allocating an unbounded queue. A cancelled uncooperative read
  retains capacity until actual settlement.
- All summary metadata is inside existing E2EE payloads; no session IDs, titles,
  clocks, outcomes, draft content or plaintext envelopes enter relay routing
  metadata, logs, telemetry or server persistence. No new server storage, public
  local listener or generic native API access is introduced.
- Native method availability and optional fields bound compatibility. Unknown
  or absent metadata never means success/read. UI read acknowledgments require
  foreground latest-content rendering and use a captured completion clock;
  reconnect and late acknowledgments cannot silently consume a newer completion.

Shared fixtures, adapter/dispatcher authorization and journal tests, stream
resource tests and isolated real-OpenCode relay integration verify this boundary.
