# ADR 0003: Chat pins and explicit session deletion

Status: accepted and implemented at the user's request, 2026-09-05.

## Decision

Chat rows expose Pin/Unpin and Delete. Pins are device-local presentation
preferences stored in native secure storage: at most 20 opaque session IDs per
project, with hashed keys scoped to server/account, connector, pinned peer key,
and canonical project path. No title, path, message, or draft is stored in the
record. Pins survive restart and same-account sign-in. A changed or revoked
identity cannot access old pins through the repository. Writes are serialized;
storage failure preserves the previous displayed state.

Pinned chats precede ordinary chats, ordered within each group by update time.
The new `chat.get` capability reads an authorized main-session summary so older
pins appear even before loading another page. Mobile fetches at most three
summaries concurrently and removes definitively missing pins.

The independently advertised `chat.delete` capability accepts only version,
opaque project handle, and session ID. Mobile confirms permanent removal from
OpenCode, including sub-agent conversations. Confirmed deletion removes the row,
pin, and retained draft. Failure or uncertain outcomes preserve the row pending
reconciliation. Offline and unsupported requests never invoke deletion.

The adapter uses the supplied OpenCode SDK's `session.delete` operation,
documented in the [official SDK](https://opencode.ai/docs/sdk/#sessions).
Real integration tests pin its behavior to OpenCode 1.18.25.

## Threat analysis

- Existing authenticated encryption, pinned-client trust, relay account
  isolation, strict versioned schemas, replay rejection, and expiry still apply.
- A known session ID is insufficient authorization. Revalidate canonical
  workspace membership; reject direct deletion of child sessions.
- OpenCode cascades deletion to descendants. Validate the entire tree before
  mutation, rejecting foreign workspaces, cycles, or more than 256 sessions.
  Reject running sessions/descendants with `chat_busy`; the user must stop first.
- One ten-second deadline bounds traversal, status checking, deletion, and
  verification. Every checked session must return 404 before reporting success.
- Deletion joins the five-minute mutation journal. Duplicate request IDs reuse
  results; changed payloads are rejected. No automatic destructive retry occurs
  after an uncertain outcome. Restart/journal expiry prevents exactly-once claims.
- Telemetry uses fixed errors, with no paths, titles, prompts, keys, native
  error bodies, or decrypted envelopes. No filesystem deletion is exposed.

OpenCode provides no transaction spanning validation and deletion. Concurrent
local changes to session ancestry/activity can race these checks; compromised
local OpenCode is outside the trust boundary. There is no undo or server backup.

## Verification

Tests cover pin persistence/isolation, ordering across refresh/pages, storage
failure, confirmation/cancel, duplicate and failed deletion, strict contracts,
and fixed encrypted errors. Real OpenCode tests cover child/grandchild removal,
foreign descendants, and preservation of unrelated sessions. Native Android
checks pins and deletion through the encrypted relay and real plugin. Native
iOS still requires an isolated Apple test environment.
