# ADR 0016: Preserve mobile chats across OpenCode session moves

## Status

Accepted. Refines ADR 0002's exact-directory membership rule for an already
authorized root session; initial discovery and directory access remain exact.

## Problem

OpenCode can move a session during an agent turn. Its authoritative location and
project ID then change, without changing its session ID or conversation history.
Capturing a directory at plugin startup both hid these chats from lists and
denied the phone's existing project/session handle, terminating streaming and
control until the user changed local configuration or restarted OpenCode.

## Decision

- Anchor project handles to the TUI's launch directory (`data.location.default`),
  not the currently selected session's mutable `context.location`.
- Remember the identity of each root session verified in an authorized directory.
  Access to that same root follows subsequent locations reported by `session.get`.
  Every operation still validates its original project handle and re-reads the
  session's identity, parent relationship, and current canonical directory.
- This is a **session-specific grant**, not authorization for its destination.
  Neither other sessions at that destination nor `project.open`, `chat.create`,
  directory enumeration, or configuration APIs become available there.
- Locally open TUI root sessions also authorize that individual chat under the
  launch project. This recovers a chat moved before the connection holder saw it.
  Each TUI advertises at most 64 open tab/current-route session IDs alongside its
  existing private, expiring directory announcement. The holder reads the union
  for that exact canonical launch directory. The global cached session list is
  never an authorization source.
- Hold at most 2048 root/project bindings in memory, without content, titles or
  models. Keep the adapter for the TUI lifetime, including relay reconnects and
  ownership reacquisition. At capacity fail explicitly with `context_expired`,
  rather than silently evicting an active chat or growing unboundedly. Bindings
  disappear on confirmed deletion, local deletion events, or plugin teardown.
- Move events only mark known sessions for reconciliation; reconnect marks all
  known roots. Event-supplied paths never grant access. An open chat can also
  recover without the event because every request reads `session.get`.
- Prepend verified moved roots before native directory pagination, using opaque,
  project-bound cursor state, so an active moved chat stays on the first page.
  Fill remaining response space with a smaller native page and resume native
  pagination at 50 entries per page. Each response and reconciliation pass is capped at
  50 entries and shares the request deadline. Concurrent moves remain eventually
  consistent, like native pagination. A reconciliation page may be empty with an
  advancing cursor when candidates have moved back or been deleted.
- Keep history cursors and stream targets bound to the original project/session
  IDs. Presentation, model validation, forks and child reads use the root's current
  directory. Child access still requires the claimed immediate parent and exact
  current directory; delete verifies the entire cascade before mutation.

No public protocol, server storage, or mobile update is required.

## Threat analysis

| Threat | Control |
| --- | --- |
| Phone guesses a foreign session or destination | Initial exact-directory membership or an explicit local TUI tab; known ID alone is insufficient |
| Following a chat exposes the entire destination | Session-specific binding; directory-scoped operations still use the original registry |
| Forged move payload authorizes a path | Event paths ignored; authoritative session-by-ID read on every operation |
| Global TUI cache leaks other projects | Only open local tabs/current route are announced, scoped to the launch directory |
| Standby process crashes or original workspace access expires | Existing heartbeat expiry and registry revalidation still apply before every request |
| Malformed/private presence records | Version, absolute path, control characters, session ID syntax/count, file-size/count and freshness checks |
| Symlink retarget or directory replacement masquerades as a move | Pin canonical path/device/inode at each current location; unchanged raw path cannot change canonical target |
| Child or fork bypasses root scope | Verify immediate parent, fork source and current directory; reject foreign cascade members before deletion |
| Resource exhaustion | Bounded announcements, bindings, pagination, lookahead and request deadlines; no remote-supplied location |
| Sensitive state reaches the relay or logs | Only existing encrypted normalized replies; local announcements contain IDs/paths only, with private permissions |

OpenCode remains trusted to report moves and session identity. The remote client
cannot request a move through this protocol. A previously authorized chat remains
authorized after a native move; moving is not a per-chat revocation mechanism.
Local connector revocation still disables all remote access. Path-based APIs retain
the documented local validation/use race.

Bindings are not a durable conversation database. After complete plugin teardown,
only exact-directory sessions and locally open TUI sessions can be rediscovered;
an arbitrary old moved session ID from mobile is not sufficient authorization.

## Verification

Unit tests cover repeated/missed moves, stable history cursors, destination model
validation, list pagination beyond 50 moved chats, locally open-tab recovery,
standby-TUI discovery and expiry, foreign-session denial, symlink/inode checks,
and child/fork/delete scope. The real OpenCode encrypted-relay integration moves
a session while subscribed, verifies live updates and history continuation under
the original handle, and exercises list/get/abort/fork/delete/prompt without an
OpenCode restart. It also denies unrelated destination chats and path opening.
