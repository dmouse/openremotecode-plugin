# OpenCode 1.18.25 project and session validation

Validated on Linux x86_64 with the published OpenCode 1.18.25 executable and
`@opencode-ai/sdk` 1.18.25. This completes the compatibility investigation in
iteration 1 of the [mobile chat plan](../../../../mobile/docs/chat-navigation-plan.md).
It does not enable new remote operations or mobile screens.

## Reproduce

Use a separate pinned executable when your interactive OpenCode has another
version. Do not downgrade your normal installation:

```sh
OPENCODE_TEST_BINARY=/path/to/opencode-1.18.25 \
  pnpm --filter @openremotecode/opencode test:projects
```

The test fails if `/global/health` reports another version. Its fixture starts
OpenCode and a simulated relay on loopback, loads the built remote plugin, and
creates two temporary Git repositories, a linked worktree, and non-Git folders.
Home, configuration, cache, state, connector identity, and session data are
temporary. Provider credentials and developer OpenCode environment overrides are
not inherited. Test messages use `noReply`; the async failure case uses an absent
provider with every provider disabled. No model service or real account is needed.

The fixture records only synthetic session identifiers, fixture directories,
event types/status, and lifecycle markers inside its temporary directory. Process
output and message contents are not printed. Cleanup stops its process and
sockets and removes temporary data even when assertions fail.

## Observations and consequences

| Tested behavior | Result | Consequence for the remote client |
| --- | --- | --- |
| `project.current()` for two Git repositories | Distinct project IDs | Preserve project identity |
| Linked Git worktree | Same project ID, different directory | Workspace selection needs a separate directory-bound handle |
| Two non-Git folders | Both use project ID `global`; plugin worktree is `/` | Neither project ID nor worktree alone authorizes a folder |
| `project.list()` | Git project records and one global record | This is not a complete directory picker or an authorization list |
| Default `session.list()` | Directory-scoped; the supplied plugin client keeps its own context | Current-directory chat browsing is viable |
| Explicit list `directory` | Overrides the SDK client's default | Remote arguments must not bypass local workspace policy |
| List with `scope=project` | Includes sessions from the linked worktree | Do not use this scope for a single-workspace list |
| Session/get and messages with another directory | Return the target session/history anyway | Check session membership before reading history or dispatching actions |
| Create session with no provider | Succeeds, starts with empty history | New chat can be created before sending any model request |
| Child sessions | Included in ordinary lists; discoverable through children; `roots=true` filters them out | Keep related chats reachable if primary rows hide children |
| Default legacy list with 107 sessions | Returns 100 without completeness metadata | The current remote operation cannot promise all chats |
| Legacy `limit=200` in that fixture | Returns 107 in updated-descending order | Limits work, but increasing limits is not cursor pagination |
| SDK v2 client's `v2.session.list()` | `/api/session` supports directory-filtered cursor pages; all 107 IDs recovered without duplicates | Use the pinned paginated API behind the compatibility adapter for the next list contract |
| Last nonempty session page | Still has a next cursor; subsequent empty page has null cursors | Continue until exhaustion; a next cursor alone does not prove another item exists |
| Message history `limit=2` | Latest bounded slice in chronological order; `X-Next-Cursor` continues older history | Normalize history pagination independently from session pagination |
| Message ID passed as `before` | Rejected with 400 | Use the returned cursor, not an assumed message-ID cursor |
| Missing directory | Project activation and session creation succeed without creating the directory | Validate existence before calling OpenCode |
| Regular file used as directory | 500; no plugin initialization observed | Return a normalized path error before SDK activation |
| Directory activation | Starts a plugin instance and loads project-local plugin configuration | Opening a folder is an execution/trust boundary |
| Several directory contexts | Separate outbound sockets with one persistent connector key | Current production relay registration rejects duplicate `(account, keyId)` connections; endpoint routing must precede project switching |
| Events from fixture actions | `session.created`, busy, error, and idle delivered to their directory's hook | Normalize and filter by workspace/session before forwarding |
| Idle status | Empty status map after creation/failure | Missing entries are not proof that the connector is offline |
| Dispose one directory | Its hook runs and relay closes; others remain connected | Supervise directory lifecycles independently |
| Reopen disposed directory | New plugin/socket, same identity and authoritative session list | Reconnect must resnapshot and cannot rely on the old socket |

## Decisions for implementation

Adopt [ADR 0002](adr/0002-authorized-project-contexts.md) before adding path entry.
The first mobile browsing milestone stays in the active workspace. New session
and history contracts must expose bounded pages and explicit exhaustion, with
opaque product cursors bound to the authenticated client and workspace. Do not
change the existing strict `session.list` request silently.

The installed plugin supplies the older SDK client shape. The newer paginated
method was exercised through a separate local SDK v2 client in the fixture; it
is not yet wired through the production plugin's supplied transport. Contain that
adaptation in the OpenCode adapter, retain the supplied client's local transport
and authentication behavior, and validate it through encrypted relay E2E before
advertising the paginated capability. Do not infer a public port or add another
remote HTTP connection. Fail explicitly if the pinned method is unavailable;
do not fall back to claiming the first 100 sessions are complete.

Native OpenCode cursors can encode paths and filtering state. Do not log them,
put them in relay routing metadata, or trust a client-supplied native cursor to
preserve authorization. Keep native cursors local behind bounded, expiring
product handles; revalidate returned session membership on every page.

## Evidence and limits

- [Compatibility tests](../test/integration/project-behavior.test.mjs) exercise
  actual SDK/HTTP calls, the built remote plugin, and encrypted list round trips.
- [Isolated fixture](../test/support/opencode-project-fixture.mjs) instruments
  real plugin initialization, event hooks, and disposal.
- [Current adapter](../src/opencode-adapter.ts) and
  [handshake](../../../protocol/src/protocol/handshake.ts) still expose the
  current unpaginated capability; this iteration makes no runtime contract change.
- [Production relay registration](../../../../server/internal/relay/production.go)
  rejects a second connection with the same account and identity. The simulated
  relay intentionally accepts all sockets to observe plugin lifecycle behavior;
  that does not prove multi-endpoint production routing.

These tests characterize OpenCode; they do not prove a remote path-policy
implementation, account isolation, or resistance to malicious local code. Static
pagination coverage does not establish snapshot consistency while sessions are
changing. Provider streaming, abort/permission behavior, Windows paths, macOS,
native mobile encryption, and production multi-endpoint routing belong to the
subsequent implementation and release checks.

## Rename And Fork Runtime (2026-09-06)

`chat.rename` and `chat.fork` now implement the existing version-1 chat-summary
convention, as described in the [wire contract](../../../protocol/CHAT-MUTATIONS.md)
and [ADR 0005](adr/0005-chat-rename-and-fork.md). The supplied legacy SDK 1.18.25
supports `session.update` with only `body.title`, and `session.fork` with an empty
body to omit the optional message cutoff. Both retain the local SDK transport,
authentication, and explicit validated directory.

The new pinned encrypted integration confirms forks have no `parentID`, copy
all source messages with new IDs, preserve the original history, and appear in
both existing root-only lists, including after adapter recreation. Subagent
children remain excluded. Full-length rename titles work; native fork suffixes
are truncated only in normalized display summaries. Fork does not copy child
sessions. No parent-filter relaxation or ancestry persistence was needed.

Run from `plugin`, after `pnpm run build`:

```sh
OPENCODE_TEST_BINARY=/path/to/opencode-1.18.25 \
  node --test --test-timeout=45000 test/integration/chat-mutations.test.mjs
```

Tests use the existing disposable fixture and require neither real accounts nor
model credentials. Busy/retry denial, unavailable status, SDK deadlines, and
failed verification are covered by unit tests; there is no atomic local
status-and-fork transaction. Runtime errors are fixed and encrypted. Both
mutations participate in the existing five-minute execution journal and require
snapshot/list reconciliation after uncertainty.

The normal executable may be newer: use a separate pinned test binary, never
downgrade or stop the interactive installation for tests. Rebuilding this package
does not hot-reload a running OpenCode plugin. To activate the new capabilities,
restart the relevant OpenCode instance when convenient, then reconnect clients
and fetch fresh capabilities/project handles. No running instance is restarted
by this change.
