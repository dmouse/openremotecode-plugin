# Explicit persistent folder approvals

Status: accepted; folder-policy milestone implemented, server hosting deferred.

## Context

A background service has no useful TUI launch-directory scope. Automatically
exposing every loaded location or every known project would turn discovery into
authorization. A paired phone must see only folders explicitly approved locally.
This supersedes the automatic directory-grant policy in ADR 0002 and the
directory-presence portions of ADR 0013, not ADR 0016's session-specific moves.

## Decision

- `/remote` inspects the current TUI location when invoked (falling back to the
  TUI default only when no location is selected). It shows the full canonical
  folder path, enabled/not-enabled state, and an explicit Enable or Disable
  action. Both actions require confirmation; escape, cancellation and failures
  never approve access. A pending dialog stays scoped to the path it displayed.
- Persist one versioned record per canonical path in `approved-folders/` beside
  the connector identity. Records pin path, device and inode, not conversation
  content. Atomic per-folder writes avoid lost updates across TUIs approving
  different folders. Directories are 0700 and files 0600 on POSIX. Reads are
  bounded, reject permissive files and symlinks, and validate schema and filename.
- Re-read approvals instead of trusting an in-memory snapshot. A directory
  replacement or missing directory grants nothing, even after a connector restart.
  Symlink aliases resolve to the reviewed canonical target, not a future target.
- The production workspace registry starts empty. Neither the launch directory,
  live presence, previously known OpenCode projects, nor `projectDirectories`
  grants access. Existing installations must opt in; do not silently migrate
  implicit grants. The generic adapter constructors still accept explicit
  registries for isolated fixtures and tests.
- Gate legacy `session.list`, all chat operations, snapshots, model lists and MCP
  reads. Recheck read results after awaited SDK calls. Streams recheck approval
  for snapshots and monitor local authorization every second without polling
  OpenCode. MCP subscriptions use their existing authorization-checked polling.
- Disable denies new work and ends live subscriptions; it does not undo prompts
  already admitted, erase local chats, clear a phone's already displayed content,
  or automatically resend a mutation with an uncertain outcome.
- Preserve stable project handles and session-specific moved-chat access, but
  only while the original folder remains approved. A moved chat never grants
  its destination folder or unrelated sessions there.
- Remove mobile path-entry UI. List only enabled projects and explain how to
  approve one locally through `/remote`; an empty list does not default to the
  server working directory. Ignore an older connector's `pathEntry: true` in UI.
  Keep `project.open` as a gated legacy operation; advertise `pathEntry: false`.

Approvals are local to a connector data directory, shared by its TUI instances,
and retained across re-pairing. Separate connector/service scopes must use
separate data directories, as identity and pairing already require. Pairing and
folder approval are independent gates; neither authorizes remote access alone.

## Threat analysis

| Threat | Control |
| --- | --- |
| Global service exposes every known project | Empty-by-default explicit folder allowlist |
| Phone self-authorizes a typed path | No mobile entry UI; legacy resolve can only select an approved path |
| Another TUI opens a private project | Presence is recovery metadata, never a directory grant |
| Folder or symlink is replaced after consent | Canonical path and persisted filesystem identity rechecked on reads and before approval writes |
| Concurrent local approvals lose a grant | Independent atomic per-folder files, not shared list read-modify-write |
| Malformed, oversized or permissive approval record | Bounded strict decoding, filename verification, no-follow open and fail-closed read policy |
| Disable races with SDK response or idle stream | Post-read authorization checks and bounded local stream authorization monitoring |
| Moved session bypasses a revoked original project | Original registry handle is rechecked before access, regardless of continuity bindings |
| Paths leak through relay metadata or diagnostics | Existing encrypted project payloads only; fixed approval error UI, no new content logging |

As with the existing identity store, another process controlling the same OS
account can modify local approvals. Protecting against a compromised local
machine is outside the trust model. An operation already handed to OpenCode
cannot be retroactively unexecuted, and delivered data cannot be recalled.

## Hosting boundary

This change deliberately does not activate the inert server entry, discover
server credentials, expose a port, or call OpenCode internals. The current server
plugin context lacks the full session/history/forms surface required by our
adapter. Approvals persist after a TUI exits, but the relay is still TUI-hosted:
at least one TUI must remain open. Future service hosting can consume this same
approval store after supported APIs and project activation have been validated.

## Verification

Tests cover default denial, persistence, multiple writers, symlink aliases,
replacement and missing directories, malformed records, permissions, cancelled
and failed dialogs, the current versus launch folder, revoked old handles and
moved chats, legacy and MCP reads, in-flight results, and mobile empty/search
states and older connectors. The isolated real-OpenCode encrypted relay test
also verifies approval and subsequent denial without touching the live service.
