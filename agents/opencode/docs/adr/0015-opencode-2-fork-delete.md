# ADR 0015: Authorized fork and deletion on OpenCode 2

Status: accepted and implemented.

## Decision

The TUI connector advertises the existing `chat.fork` and `chat.delete` v1
product operations. It uses only its supplied OpenCode client: `session.fork`
without a message boundary clones the entire history into a root session;
`session.remove` deletes an idle root and its children. The phone already
implements these actions, including explicit delete confirmation and uncertain
outcome handling. Empty sessions cannot be forked on OpenCode 2, so the phone
disables Fork for an empty loaded chat. Rename remains unsupported.

## Threat analysis

- The relay authenticates and decrypts requests from the pinned mobile identity,
  validates strict operation-specific bodies, and journals mutations by request
  ID. An attacker cannot choose an SDK method, path, fork boundary, or arbitrary
  delete target by supplying extra fields.
- Resolve the opaque project handle and recheck canonical path, device and inode.
  Fetch the target by ID and verify its ID, canonical directory and root status.
  Recheck before mutation; a returned fork must have a new ID, no `parentID`, a
  fork source matching the target, and the same authorized directory. Re-read
  the new fork by ID before acknowledging it; never return a foreign,
  mismatched, or nonexistent native response.
- Delete enumerates direct children recursively with an unfiltered native
  `parentID` query, at most 256 sessions in total. Verify each returned parent
  relation and directory, reject cycles and non-progressing pagination, and
  re-read every member before removal. This avoids hiding a foreign descendant
  behind a directory filter. All discovered members must be absent from the
  active-session map; unknown active states are treated as busy. Confirm each
  member no longer exists before acknowledging deletion.
- A single ten-second abort signal is passed to native reads and mutation. SDK errors,
  timeouts, or failed post-mutation verification produce fixed encrypted errors
  (`uncertain_outcome` for unclassified mutation failures); the phone does not
  automatically retry a destructive or duplicating request. The native
  `empty_session` fork refusal is definitive and maps to `context_expired`.
  Post-mutation authorization or verification failures remain uncertain rather
  than inviting an automatic or user-initiated duplicate fork.
  Logs contain fixed operation names and codes, never session contents or paths.

OpenCode has no transaction spanning authorization, child enumeration, activity
checks, and mutation. Concurrent local changes after verification can still
race the native operation. Aborting a request cannot roll back a fork or deletion
that OpenCode already started. The native remove operation owns cascading
deletion; this connector never deletes files itself. The in-memory journal is
bounded and cannot deduplicate across plugin restarts.

## Verification

Adapter tests cover root/child/foreign scope, active descendants, return
identity, definitive empty-session refusal, cascade and missing-delete
verification. Encrypted integration against the pinned OpenCode 2.0.12 client
and server exercises full-history fork, empty fork refusal, delete, and cascade
to a real imported child. The mobile action suites cover idle/empty gating,
confirmation, source changes, and uncertain outcomes.
