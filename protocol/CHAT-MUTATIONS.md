# Chat Mutation Contract V1

The authoritative validators are in `src/protocol/chat.ts`. Language-neutral
examples, including rejected requests, are in
`test/fixtures/chat-mutations-v1.json`. These operations use the same strict
body versioning and `chat` response key as `chat.create` and `chat.get`.

## Requests

`chat.rename`:

```json
{"version":1,"projectId":"adfcaa47-d299-4d49-9137-fbac353c7cbd","sessionId":"ses_source","title":"New title"}
```

`chat.fork`:

```json
{"version":1,"projectId":"adfcaa47-d299-4d49-9137-fbac353c7cbd","sessionId":"ses_source"}
```

Every field shown is required; additional fields are rejected. `version` must
be the number `1`, `projectId` a connector-issued UUID workspace handle, and
`sessionId` a nonempty string of at most 128 UTF-16 code units. Rename trims
leading/trailing ECMAScript whitespace from `title` before requiring 1 through
512 UTF-16 code units. Whitespace-only/non-string titles fail. Padded titles are
accepted and normalized, not rejected. Fork accepts neither `messageID` nor
`messageId`: it copies the full source history at the end, with no cutoff.

## Responses

Both operations return exactly:

```json
{"version":1,"chat":{"id":"ses_result","title":"New title","updatedAt":1788652800000}}
```

`chat` uses the existing strict `ChatSummary` schema: required `id` (1-128 code
units), `title` (0-512 code units), and `updatedAt` (nonnegative safe integer,
Unix milliseconds), with optional `parentId` (1-128 code units). Unknown fields
are rejected. Rename returns the original session ID; fork returns a new session
ID. The pinned plugin returns roots for both, so `parentId` is absent. Native
fork titles can exceed 512 units; summaries truncate display titles without
changing OpenCode's stored title. Clients must treat summaries as display data,
not infer fork identity from title suffixes or `parentId`.

These bodies are carried in the existing encrypted relay payload:
`{protocolVersion:1, kind:"request"|"response", requestId, sentAt, operation, body}`.
They introduce no HTTP route or server-readable content. Capability keys are
exactly `chat.rename` and `chat.fork`; clients must not send them to a connector
that does not advertise them.

## Failures And Reconciliation

Failures use the existing encrypted `protocol.error` body `{code,message}`.
Strict validation produces `invalid_request`; a missing capability/operation
produces `unsupported_operation`. Workspace/target checks can return
`access_denied`, `context_expired`, or `chat_not_found`. Fork rejects authoritative
`busy`/`retry` status with `chat_busy`; rename does not require idle state.

Timeouts, SDK failures, and failed mutation readback produce `uncertain_outcome`:
the operation may have completed. Refresh chats/snapshots and obtain explicit
user intent before another mutation. Matching request-ID/operation/body retries
share the existing journaled execution for five minutes; changed payload reuse
is rejected. Do not promise exactly-once execution after journal expiry or
connector restart, or assume a cached encrypted reply remains valid past its
envelope expiry. A fork is a new OpenCode session, not an undo or backup service.
