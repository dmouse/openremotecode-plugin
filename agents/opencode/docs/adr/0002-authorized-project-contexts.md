# ADR 0002: Authorized project contexts and bounded chat discovery

## Status

Accepted and implemented for the first mobile chat iteration, with the
single-endpoint limits below. Legacy `session.list` and paginated `chat.list`
now exclude sessions with a parent; child sessions are not shown in chat lists.

## Context

Mobile will select a known project or open an existing directory by path. The
pinned OpenCode 1.18.25 investigation (removed with 1.x support, see ADR 0014) showed
that project IDs are not workspace boundaries, directory selection initializes
plugins, missing directories are accepted, and session-ID lookup ignores a
different supplied directory. Default session listing also silently caps at 100.

The server must continue routing opaque encrypted content. Account membership,
knowledge of a path, and knowledge of a session ID do not authorize local access.

## Decision

### Local access policy

Default to the canonical directory supplied to the active plugin. Do not derive
the default from `project.id`, `project.worktree`, or the plugin `worktree`, which
can be `/` for non-Git folders. Additional roots must be configured or approved
locally. Pairing and remote path entry cannot enlarge this policy.

Treat the default as the exact active workspace, not implicit authorization for
every nested project. Any later recursive allowed-root option must be explicit
locally: authorizing subdirectories permits their project configuration/plugins
to initialize. The mobile UI can explain a denied path without exposing other
local folders or presenting a remote “allow permanently” control.

Only existing directories can be opened. On the connector's OS, require an
absolute path, reject control characters and shell/URL forms, canonicalize with
`realpath`, verify directory type, and compare complete path components against
the local policy. Symlinks must resolve within allowed scope. Do not execute
shell commands, create folders, initialize Git, or browse arbitrary files.

Check policy before any SDK call that could activate a directory. Revalidate
canonical identity and policy before each operation. Detect directory replacement
and changes between validation and use, invalidate the handle, and fail closed
where detected. Path-based SDK calls cannot atomically bind validation to a
filesystem object; document the remaining local race instead of claiming that
canonicalization eliminates it. A malicious local process is outside the trust
boundary, but remote traversal and symlink escapes remain covered threats.

### Workspace and session identity

Issue an opaque workspace handle scoped to the active connector adapter and
canonical directory. The adapter lifetime fixes the local directory policy;
restart invalidates its handles. Every command independently requires a pinned,
authorized client. All authorized clients on that connector share the same local
workspace policy; handles are references, not bearer authorization.
Project IDs and display paths are descriptive only. Keep directory mappings local
and send human-readable metadata only inside encrypted responses.

For every session operation, verify that the authoritative session belongs to the
bound workspace before retrieving messages or dispatching a mutation. Recheck
returned summaries, child sessions, pages, and events too. Do not authorize a
session merely because OpenCode returned it for an ID or because it was once in
a list. Unknown, expired, mismatched, or revoked handles fail closed with bounded
product errors. Clear relevant handles and decrypted state on revocation.

### List completeness

Use bounded directory-filtered cursor pagination via the pinned `/api/session`
behavior behind the OpenCode adapter for the next session-list capability. Keep
the older SDK/transport adaptation internal and test it before advertising support.
The experimental cross-project session API is not required. Normalize native
records; raw SDK objects and native cursor encodings are not public contracts.

Native cursors stay in a bounded, expiring plugin map keyed by opaque product
cursors. Bind entries to the adapter workspace and, for history, session context; an expired cursor
requires a fresh list. This short-lived synchronization state is not a second
conversation database. Recheck authorization on every continuation.

Use explicit exhaustion; the final nonempty native page can still have a cursor.
Empty pages must not cause infinite loading or skip to another workspace. Bound
lookahead, response bytes, item counts, command time, and retained cursor state.
If a safety cap is reached, return a recoverable incomplete result. Never label
the current legacy 100-session response or a capped result “all chats.”

Message pagination uses the returned native history cursor through a separate
normalized contract. Keep search scope explicit. During concurrent updates,
deduplicate by session/message ID and reconcile authoritative snapshots; do not
promise a stable database snapshot or exactly-once mutation execution.

### Endpoint lifecycle

Keep this iteration on one active connector endpoint. All operations use that
endpoint's supplied SDK transport and explicit directory, including directories
listed in the locally configured `projectDirectories` option. Handles belong to
that adapter instance. No independent routing to other plugin instances is
advertised. Remote path entry cannot expand the exact-directory policy.

OpenCode initializes a plugin instance for every directory it works in, and all
instances on a machine share one connector identity. The relay admits one
connection per identity and evicts the older one when the identity connects
again. Left uncoordinated, two instances evict each other in a reconnect loop, so
neither project stays reachable and requests land on whichever instance happens
to hold the connection, often one that does not know the requested project.

Exactly one instance per state directory therefore owns the relay connection,
guarded by a lock file in the plugin's data directory (`connector-instance.lock`).
The owner refreshes the file's modification time every second; a lock not
refreshed for five seconds is stale, so a crashed owner never blocks the others.
The other instances wait and take over when the owner exits. Every refresh
re-verifies the lock's token, so an owner suspended past the stale window stops
its relay rather than contending. Process IDs are not used for liveness because
they are reused and differ between containers. Pairing, credential renewal, the
revocation retry and the connection status file are owned by the same instance,
so a waiting instance cannot disturb them. Reconnect backoff restarts only after
a connection has stayed admitted for ten seconds, so any remaining contender for
the identity, such as a copied identity on another machine, backs off instead of
retrying at the minimum delay.

The owner serves only its own directory and the `projectDirectories` option, and
authorization is never widened by another instance's presence. Every
project that should be reachable must therefore be listed in
`projectDirectories`, in the config of any instance that might own the
connection. A waiting instance logs that fact once. This remains a
multi-directory lifecycle limitation. The native test baseline
covers the current directory. Supporting independently selected concurrent
endpoints requires versioned opaque routing, ownership checks, separate queues,
and lifecycle integration tests before release. Do not re-pair implicitly or
allow ambiguous duplicate routes to work around collisions.

## Threat analysis

| Threat | Required control | Remaining limit |
| --- | --- | --- |
| Authorized client guesses another directory/session | Local policy, opaque bound handles, independent session membership check | Compromised authorized local machine can alter its own state |
| Non-Git `global` identity or `/` expands access | Default to exact canonical plugin directory | Locally configured recursive roots intentionally expand trust |
| Traversal, symlink escape, or replaced directory | OS-native canonicalization/type checks, component comparison, revalidation | Path-based SDK leaves a local validation/use race |
| Path activation loads untrusted config/plugins | Check policy before activation; locally review any expanded roots | Approved project plugins execute with local OpenCode privileges |
| Tampered cursor changes scope or reveals paths | Local native-cursor map, bound opaque handles, validate every returned session | In-memory map loss forces a new list |
| Concurrent endpoints cross-route replies/events | Authenticated endpoint scope, request correlation, independent queues | Independent endpoint selection remains unavailable; extra-directory lifecycle requires further tests |
| Cross-account access or stale device trust | Relay account isolation plus plugin pin/authorization checks | Server membership alone is insufficient end-to-end authorization |
| Resource exhaustion or infinite pagination | Bounded input, pages, bytes, queues, cursors, deadlines; explicit incomplete state | Very large or rapidly changing histories may require retry/resync |
| Sensitive metadata leaks via telemetry | Fixed operation/error labels and aggregate timing/counts only | Native OpenCode's own local logging is a separate system boundary |

Prompts, responses, paths, titles, searches, cursors, SDK error bodies, keys, and
decrypted envelopes must not appear in remote-service telemetry. Report bounded
failure codes, operation latency, queue pressure, and counts without content.

## Verification and consequences

The compatibility suite establishes the OpenCode behavior motivating these
controls. Adapter tests cover malicious paths, directory replacement, mismatched session
and workspace IDs, cursor scope, and main-session filtering. Dispatcher tests
cover version/argument rejection, encrypted bounded errors, replay, and mutation
deduplication. Native Android covers the encrypted real-plugin/OpenCode path.
Broader multi-endpoint lifecycle, iOS, and telemetry auditing remain release work. Characterization
tests that demonstrate permissive OpenCode behavior are not substitutes for those
authorization tests.

Project selection and creation can then be added without making the user's
filesystem publicly reachable or making the relay a conversation store. Local
policy UX and endpoint wire contracts require implementation work in their planned
milestones. No new permanent permission grant or general OpenCode API proxy is
authorized by this design.

## Native transport and execution limits

Mobile uses authenticated HPKE P-256/HKDF-SHA256/AES-256-GCM through Bouncy Castle
on Android and CryptoKit on iOS 17+. The existing protocol binds outer routing
metadata as associated data. Native crypto work is queued off the platform UI
thread; mobile caps four pending requests and concurrent decryptions. Outer
frame/expiry checks and peer/request/operation correlation precede UI updates.
No keys, plaintext envelopes, or raw SDK errors are logged.

Plugin requests have a bounded replay window and eight-command limit. A
five-minute, 128-entry in-memory mutation journal binds request IDs to operation
and body hashes, sharing responses for matching duplicates and rejecting changed
payloads. Restart loses the journal; timed-out operations may have executed.
Clients surface uncertain outcomes and require an explicit retry after refresh.
Native sealing that finishes after cancellation or timeout cannot send a command.
