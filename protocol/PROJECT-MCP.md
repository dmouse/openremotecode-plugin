# Project MCP Status V1

MCP status is a separate encrypted project topic, never a `chat.snapshot` flag or
chat message. The connector advertises `project.mcp.snapshot`,
`project.mcp.subscribe`, `project.mcp.unsubscribe`, and `project.mcp.updated`.
The last capability is an event marker and cannot be called. No MCP tools,
connect/disconnect, authentication flows, configuration or execution are exposed.

## Wire Contract

All bodies are strict objects. IDs are UUIDs. `version` is exactly `1`.

| Operation | Request Body | Response Body |
| --- | --- | --- |
| `project.mcp.snapshot` | `{version, projectId}` | `{version, projectId, state, servers}` |
| `project.mcp.subscribe` | `{version, projectId, subscriptionId}` | `{version, projectId, subscriptionId, revision, state, servers}` |
| `project.mcp.unsubscribe` | `{version, projectId, subscriptionId}` | `{version: 1, unsubscribed: true}` |

An update uses inner envelope `kind: "event"`, operation `project.mcp.updated`,
and exactly the subscribe response body. Its envelope `requestId` **must equal**
`subscriptionId`. Responses retain the initiating request's ordinary `requestId`.
An initial event can arrive before the subscribe response. Clients retain the
highest revision for the active subscription and discard older/equal revisions.

`revision` is a safe nonnegative integer. Initial subscribe starts at zero;
successful renewals and changed polls strictly increment it. A poll emits a full
replacement only when the normalized snapshot changes, including server renames,
removals, empty lists, and changes between ready/unavailable.

`state` is `ready` or `unavailable`. `unavailable` requires `servers: []` and does
not mean no configured servers. Only `ready` with an empty list means none.
Each server is exactly `{name, status}`. Status is one of `connected`, `disabled`,
`failed`, `needs_auth`, `needs_client_registration`. At most 100 servers are
allowed, with unique names. Names are 1..128 UTF-16 code units and exclude
`[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]`.
There are no raw errors, URLs, arguments, configuration, tool names or credentials.

The cross-client fixture is `test/fixtures/project-mcp-v1.json`. The exported
`projectMcpRequests`, `projectMcpResponses`, `projectMcpSnapshotSchema`,
`projectMcpUpdatedSchema`, and `projectMcpUpdatedEventSchema` validate the contract.

## Lease And Reconnect

- A subscription lasts 60 seconds from successful subscribe handling. Renew the
  same ID/project every 30 seconds; renewal reads a fresh snapshot and is serialized
  with that subscription's polls and revision assignment.
- At most four active or pending subscriptions exist per trusted-client dispatcher.
  Reusing an active ID for another project is denied, including unsubscribe.
- Polling occurs only for active subscriptions, three seconds after the previous
  read/send wait completes, with a shared ten-second waiting deadline. No complete native
  status event stream is assumed. SDK failures produce unavailable, not empty-ready.
- At most four underlying reads may be outstanding per reader/adapter instance,
  shared by snapshots and subscriptions. Slots remain occupied until the underlying
  promise actually settles, including unabortable filesystem work and SDK calls
  ignoring cancellation. Timeout, unsubscribe, expiry and relay reattachment do not
  free slots. Saturation returns unavailable without starting or queuing I/O.
- Unsubscribe is idempotent for absent IDs and immediately cancels waiting/delivery.
  Expiry cleans up when a client disappears but the connector relay stays online.
- Relay disconnect/disposal cancels all subscriptions and invalidates in-flight
  reads and encryption. There is no replay or server history. Reconnect/expiry
  starts a new subscription lifetime; clients should use a new ID and fresh snapshot.
- Event delivery is generation-bound and has no application-level event queue.
  Socket buffering plus each outgoing frame is capped at 2,000,000 bytes; saturation
  disconnects instead of silently losing an authoritative update. Resubscribe after
  reconnect. Existing request admission and per-subscription queues are bounded.

## Threat Analysis

- **Cross-workspace reads:** Project IDs come from the existing configured project
  registry. The plugin rechecks the exact canonical directory, device and inode
  before and after every supplied-SDK status call. Foreign, removed or replaced
  workspaces produce fixed encrypted authorization errors, never data.
- **Sensitive native payloads:** The adapter copies only validated names and status
  discriminators. Errors and native configuration are dropped; malformed, excessive
  or unknown native status results fail as unavailable, not partial success.
- **Sensitive names:** A server name, including a changed name, can itself reveal
  project or organization information. Names and changes remain plaintext only at
  authorized endpoints and inside E2EE payloads in transit. They must never be
  logged or added to outer routing metadata, traces, metrics or audit records.
- **Forged requests/events:** Existing authenticated HPKE, trusted-device pinning,
  recipient checks, authenticated outer metadata, expiry and replay rejection apply.
  Body validation happens before reads. The event marker cannot invoke an SDK method.
- **Orphans, races and resource exhaustion:** Leases, four subscription slots,
  bounded admission/renewal queues, serialized revisions, shared read deadlines,
  cancellation and generation-bound sends prevent stale renewals, late data delivery
  and unbounded event buffering. A weak per-reader counter limits underlying reads
  to four until their actual settlement; cancellation only bounds waiting and cannot
  authorize more I/O by releasing an outstanding slot. Permanently hung calls retain
  capacity until settlement or local process/adapter replacement. No unbounded
  promise collection or saturation queue is retained. No subscription is restored
  implicitly after reconnect.
- **Limits:** E2EE does not protect compromised authorized devices, a malicious web
  bundle, or the local OpenCode process. Traffic timing and ciphertext sizes remain
  visible to the relay. Status reads do not execute tools or remotely mutate MCP
  configuration; OpenCode itself remains responsible for its native MCP lifecycle.

Observability is limited to existing generic relay lifecycle/failure messages;
no per-server names or native errors are recorded. Unit tests cover contract
injection, native redaction, authorization races, encryption, replay, renewal,
expiry, reconnect, event-before-response ordering, cancellation and backpressure.
