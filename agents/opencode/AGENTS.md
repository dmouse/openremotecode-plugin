# OpenCode Plugin Architecture

## Scope

This directory contains the TypeScript OpenCode plugin that bridges one local OpenCode instance to Open Remote Code. It is the only component that translates between OpenCode SDK behavior and the product's encrypted remote-control protocol.

The plugin opens an outbound connection. It never opens a public listener and never requires the developer to expose the local OpenCode server.

The root `AGENTS.md` defines product-wide constraints and takes precedence over this document.

## Responsibilities

- Initialize with the OpenCode plugin context and SDK client for the active instance.
- Establish or restore the connector's local cryptographic identity.
- Guide first-time connector pairing and display verification information.
- Acquire short-lived relay admission and maintain the outbound WebSocket connection.
- Decrypt, authenticate, validate, and dispatch approved remote commands.
- Call the local OpenCode SDK through a compatibility adapter.
- Normalize OpenCode events into the stable product protocol.
- Encrypt responses and events for the intended trusted client device.
- Reconcile authoritative state after reconnecting.
- Report operational state through structured OpenCode logging without exposing sensitive data.

## Internal Boundaries

Keep the following concerns separate even if the first implementation is small:

- Plugin lifecycle: OpenCode initialization, shutdown behavior, project context, and event-hook registration.
- OpenCode adapter: all SDK method names, SDK payloads, event payloads, and version-specific compatibility behavior.
- Connector identity: keys, credentials, key identifiers, secure persistence, and revocation response.
- Pairing client: device authorization, polling, safety phrase derivation, and completion.
- Relay transport: ticket acquisition, WebSocket lifecycle, heartbeat, backoff, bounded queues, and connection status.
- Encrypted protocol: envelope validation, authenticated encryption, replay protection, capability negotiation, and correlation.
- Command dispatcher: explicit operation allowlist, argument validation, cancellation, and result normalization.
- Event bridge: event selection, normalization, filtering, coalescing, and client fan-out.
- Synchronization: snapshots, deduplication, uncertain command outcomes, and reconnect reconciliation.

The OpenCode adapter must prevent generated SDK types and raw events from leaking throughout the plugin. Transport must not know how OpenCode implements a session, and the OpenCode adapter must not know how WebSockets reconnect.

## OpenCode Integration

The plugin uses the SDK client supplied in its plugin context. That client addresses the same local OpenCode instance that loaded the plugin, so the plugin does not need to discover or expose the local server port.

Pin and document a supported OpenCode version range. Current event names and SDK operations must be validated in an integration spike before implementation assumptions become protocol commitments.

The adapter is expected to support session listing, session creation, message snapshots, asynchronous prompting, aborting a running response, and individual permission replies. It also consumes relevant session, message, permission, todo, and status events.

Raw OpenCode events are often partial or optimized for a local client. Convert them into stable events and use SDK snapshots when state must be reconstructed.

## Supported OpenCode

The plugin supports OpenCode 2 only. OpenCode gives a server plugin too little API to serve chats,
so the connector runs in the TUI plugin over the client it is given (`src/opencode/`, entry
`src/tui.ts`); the server entry is inert. The lifecycle in `src/connector.ts` stays independent
of OpenCode. The adapter advertises only the operations it implements and fails the rest as
`unsupported_operation`; it must never widen access by reading OpenCode's server URL or
credentials from disk. See `docs/adr/0013-opencode-2-tui-hosting.md` and
`docs/adr/0014-opencode-2-only.md`.

## Remote Capability Policy

Every command is denied unless it is explicitly supported by the dispatcher and negotiated for the active protocol version.

Initial approved capabilities are:

- Describe connector and supported protocol capabilities.
- List sessions visible to the active OpenCode instance.
- Create a session.
- Retrieve a session and its message snapshot.
- Submit a text prompt asynchronously.
- Abort an active session response.
- Reply to a permission request with once, always, or reject.
- Retrieve current session status and todos.

Do not implement a generic OpenCode API proxy. Do not accept arbitrary endpoint names or SDK method names from a remote client. Shell commands, file reads, file writes, provider authentication, configuration mutation, session sharing, are excluded until separately threat-modeled and approved. A permission reply of `always` is allowed only as the explicit per-request choice in `chat.permission.reply`.

## Event Flow

The plugin receives OpenCode events through plugin hooks and translates only events needed by the remote experience. Relevant categories include session creation and updates, message and message-part changes, session status and completion, session errors, permission requests, and todo changes.

Streaming message-part updates may be high volume. Event handling must not block OpenCode, grow memory without bounds, or assume every delta reaches the remote client. Coalesce safe transient updates under pressure and make final snapshots authoritative.

Each outgoing event is associated with an opaque endpoint and session identifier, encrypted for its recipient, and correlated with a protocol sequence. Sensitive event data must never be written to logs.

## Connection Lifecycle

Plugin initialization starts a supervised background connection loop and returns control to OpenCode promptly. Network failure must not prevent local OpenCode use.

The connection lifecycle includes short-lived credential refresh, relay-ticket acquisition, WebSocket establishment, capability negotiation, heartbeat, clean cancellation, exponential backoff with jitter, and state resynchronization.

After reconnecting, the plugin advertises current presence and responds to explicit snapshot requests. It does not assume that the server retained events while disconnected.

Mutating operations are not automatically retried after an uncertain outcome. Request identifiers and a bounded execution journal should prevent accidental duplicate prompts within the supported retry window. Read-only snapshots may be retried safely.

## Pairing and Local Secrets

On first use, the plugin generates device identity and encryption keys locally, begins a short-lived connector authorization, and displays the user code and safety phrase through appropriate OpenCode UI surfaces. Pairing instructions direct users to Add connection in the mobile app.

Private keys never leave the local machine. Prefer the operating-system credential store. Support a permission-restricted file store only as a documented fallback for environments without a usable keychain. Secret persistence is accessed through a narrow platform adapter.

The plugin proves possession of its private identity during authorization and connection establishment. It pins trusted client public identities after pairing and independently verifies sender identity after decrypting a command. Server account authorization alone is not sufficient end-to-end trust.

## Multiple Instances and Workspaces

The same user may run multiple OpenCode processes and projects. Do not expose absolute local paths as relay routing metadata.

A connector has a persistent identity. Each active plugin process advertises an opaque endpoint identifier. Human-readable project and workspace information belongs inside encrypted responses. Concurrent endpoints must not overwrite one another's connection or synchronization state.

Every instance announces its directory in the private data directory (`src/directory-presence.ts`) for as long as it runs, and the connection holder serves the union of live announcements plus the optional `projectDirectories`. Access therefore follows where the plugin is loaded: a global install reaches every folder OpenCode runs in, a per-project install only that project. Announcements expire when their heartbeat stops, are validated as hostile input, and never leave the machine as routing metadata.

## Reliability and Resource Limits

- Use bounded command and event queues.
- Limit decrypted command size before detailed processing.
- Reject stale, replayed, unsupported, or incorrectly addressed messages.
- Renew the connector credential only after relay admission has succeeded, and keep the
  renewal single-flight. Presenting the current credential cancels a pending rotation
  server-side, so a rotation started before admission cancels itself on every attempt and the
  credential silently reaches expiry. Write the replacement to the authorization file before
  activating it: activation retires the previous credential, and a credential activated but
  never recorded is a lockout. See [server ADR 0012](../../../server/docs/adr/0012-connector-credential-rotation.md).
- Scope replay state to the connection epoch, never across one. Each connection derives an
  epoch from both peers' hello nonces; outgoing sequence numbers restart at zero with it
  and the inbound sequence window is recreated with it. The mutation journal is the
  deliberate exception: it is keyed by request identifier and must survive a reconnect, so
  a client retrying after an uncertain outcome receives its first result rather than a
  second execution. See [server ADR 0011](../../../server/docs/adr/0011-relay-connection-epochs.md).
- Apply timeouts and cancellation to SDK operations where supported.
- Keep networking and cryptography off latency-sensitive event-hook paths.
- Surface connector status without repeatedly notifying or disrupting the developer.
- Shut down timers, sockets, and background work when the plugin lifecycle ends.

## Compatibility

The product protocol and the OpenCode SDK evolve independently. Capability negotiation communicates which remote operations and event forms the installed plugin supports. SDK changes are handled inside the OpenCode adapter and should not force unnecessary server or client protocol changes.

Experimental OpenCode APIs require explicit containment and must not become required product behavior without a fallback or pinned-version policy.

## Verification Expectations

Future plugin work must include unit tests for command authorization, event normalization, encryption boundaries, replay rejection, queue behavior, and reconnect state. Use a fake OpenCode adapter for protocol tests and run integration tests against a pinned real OpenCode instance for supported SDK methods and events.

Contract tests must prove that the plugin and mobile client understand the same encrypted protocol. Security tests must verify that untrusted devices, wrong recipients, modified metadata, duplicate commands, and revoked connector credentials fail closed.

## Out of Scope

- Publicly exposing the local OpenCode server.
- Uploading sessions through OpenCode share.
- Implementing the bridge as an MCP server.
- Storing server-side conversation history.
- Executing commands not present in the explicit remote capability policy.
