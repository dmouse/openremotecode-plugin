# ADR 0005: Narrow chat rename and full-history fork

Status: accepted and implemented at the user's request, 2026-09-06.

## Decision

Add independently advertised `chat.rename` and `chat.fork` capabilities through
the existing `CHAT_CAPABILITIES`/connector hello mechanism. Both follow the
existing strict version-1 `chat.*` request and normalized summary response
conventions. There is no change to the relay version or legacy `session.list`.

Rename permits only a title update. Fork permits only copying the source's
full history at the end; a message cutoff, parent ID, directory, SDK method,
permission rule, metadata, and other arbitrary fields are rejected. The pinned
SDK calls are `session.update({path:{id}, body:{title}})` and
`session.fork({path:{id}, body:{}})`, with the validated directory and a shared
ten-second abort signal. No SDK proxy, shell access, persistent permission grant,
or new local listener is introduced.

The actual OpenCode 1.18.25 integration proves forks have no `parentID`. They
are ordinary root sessions, not subagent children. Preserve both existing list
parent filters and reject rename/fork of child sessions. No process-local fork
registry, fabricated ancestry, or durable parallel conversation store is needed.
OpenCode owns the generated fork title and cloned history. Normalize display
titles to 512 UTF-16 code units in both summary adapters: OpenCode's fork suffix
can make a valid 512-unit source title exceed the wire limit. This does not
rewrite the native title.

## Threat Analysis

- Existing pinned-client authentication, encrypted routing, account isolation,
  expiry, and frame replay rejection apply before dispatch. Knowledge of a
  session ID or project handle alone is not authorization.
- Resolve the opaque workspace handle and revalidate its canonical path, type,
  device, and inode. Read the target session and verify ID and exact canonical
  directory membership before mutation; reject subagent children.
- Fork reads authoritative SDK status, rejecting `busy` and `retry` with
  `chat_busy`. An absent entry means idle in the pinned version. Malformed or
  unavailable status fails closed. Recheck workspace/session after the status
  read. Rename can run while a session is active.
- Verify the mutation result's identity, directory, root status, and normalized
  summary, then reread the resulting session in the authorized workspace. Rename
  must retain the source ID and confirm the requested title; fork must have a
  different ID. Never disclose an unverified returned session.
- One ten-second SDK deadline spans target lookup, status, mutation, and readback.
  Both operations join the existing bounded, five-minute, 128-entry mutation
  journal. Matching duplicate requests share execution/results; changed
  operation/body reuse is rejected. Timeout, SDK failure, invalid response, or
  failed post-mutation verification reports a fixed `uncertain_outcome`, never an
  automatic retry. No compensating delete or rename is attempted.
- No new content logging is added. Errors contain fixed product codes/messages,
  not titles, paths, prompts, native exceptions, credentials, or envelopes.

OpenCode has no transaction spanning status, filesystem validation, and fork.
Concurrent local work can begin after the last idle check; external renames can
race readback. Large histories can finish or partially copy after timeout.
Abort signals bound SDK waiting, not rollback of OpenCode work. The journal is
in-memory and scoped to the dispatcher: expiry/restart loses deduplication, and
cached encrypted responses retain their original envelope expiry. Clients must
reconcile authoritative lists/snapshots after uncertainty rather than silently
issue a new mutation ID. A malicious local machine remains outside the trust
boundary. A fork duplicates source session messages, not subagent sessions.

## Verification

Shared JSON fixtures and protocol tests cover strict bodies/responses, versions,
title trimming/limits, and injected SDK fields. Adapter and encrypted dispatcher
tests cover workspace/session isolation, child rejection, busy/retry/unavailable
status, returned-session verification, deadlines, uncertain outcomes, duplicate
requests, capability gating, and explicit unknown-operation rejection instead of
the former abort fallback.

The isolated pinned integration exercises the loaded plugin through encrypted
WebSocket requests. It verifies rename persistence; all twelve synthetic messages
copied with new IDs; unchanged source history; root ancestry; legacy/paginated
list visibility; fresh-adapter visibility; retained subagent filtering; foreign
workspace denial; duplicate fork deduplication; and long-title normalization.
It uses disposable directories/config/data, disabled providers, and `noReply`,
without changing running services or developer conversations. Real provider
streaming and native UI behavior are not claimed by these tests.
