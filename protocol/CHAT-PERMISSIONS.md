# Permission Presentation v1

`chat.permissions` is a display and reply capability for OpenCode's own
permission-request flow: before a tool acts in a way its configuration
requires approval for, OpenCode pauses and asks. This capability lets a
supporting client see that request and answer it, the same way a locally
attached TUI would.

Unlike every prior capability (`chat.tools`, `chat.shell`, `chat.images`,
`chat.activities`), which only ever change what a client can *see*, this one
adds something a client can *do that changes what the agent is allowed to
do*. It is the first mutating, execution-gating remote capability in this
protocol, and is scoped accordingly.

## Negotiation

A supporting client requests `includePermissions: true` on `chat.snapshot`,
`chat.subtask.snapshot`, or `chat.stream.subscribe` only when the connector
advertises `chat.permissions`. Independent of `includeTools`/`includeShell`/
`includeImages` — a permission request is not a tool part, so no `.refine`
dependency exists between them. Omitting or disabling it preserves today's
behavior exactly: no `permission` field at all, and OpenCode's local UI (TUI,
etc.) remains the only place the request is visible. The chat protocol
remains version 1.

A snapshot may carry:

```json
{
  "permission": {
    "id": "per_090dffe76001obsZ3HAvPfK17M",
    "operation": "execute",
    "description": "Run: npm install",
    "pattern": "npm i*"
  }
}
```

`permission` is absent for a client that didn't opt in, `null` when nothing
is currently pending, and this shape when something is. `operation` reuses
the exact eight-value enum `chat.tools`' tool parts already use (see
`CHAT-TOOLS.md`) — a permission request maps through the same presentation
taxonomy as a tool call, not a parallel one; an unrecognized native type
falls back to `"tool"`, same as an unknown tool does. `description` is
OpenCode's own prepared, human-readable title for the request (bounded to
256 UTF-16 units, control characters and bidi overrides stripped — the same
sanitizer every other description field in this protocol already uses).
`pattern` is an optional, similarly bounded string describing what the
permission scopes to (a command pattern, a file glob, etc.); OpenCode's
native field can be a string or an array of strings, joined before sending.
**No other native field crosses this boundary** — in particular, the
request's raw metadata object is never forwarded, matching every other
capability's "presentation allowlist, not a raw passthrough" rule.

## Reply

```json
{ "permissionId": "per_090dffe76001obsZ3HAvPfK17M", "response": "once" }
```

`response` is `"once"` or `"reject"` **only**. OpenCode's native reply also
accepts `"always"` (a persistent, saved grant beyond this one request), but
this protocol never exposes it: the product's stated scope explicitly
excludes persistent permission grants from a remote client. Widening this
later is a trust-boundary change requiring its own discussion, not a
protocol-version bump. A malformed or unrecognized `response` value fails
validation before anything reaches OpenCode.

`chat.permission.reply` requires the same project/session authorization and
child-session membership checks every other mutating operation
(`chat.prompt`, `chat.abort`) already requires; it cannot target a session
it hasn't independently verified the caller can reach. A successful reply
returns `{ accepted: true }`, the same fixed acknowledgment shape
`chat.prompt`/`chat.abort` already use.

## Visibility is live-only

OpenCode's native permission API has no endpoint to list currently-pending
requests — the only way to learn about one is the event it emits when
created. The plugin only listens for that event while at least one client
has an active `chat.stream.subscribe` for the session. A request that both
starts and needs answering while no mobile client is subscribed (app fully
closed or backgrounded) is not recoverable on the next cold snapshot — it
stays invisible to this remote path until the next request happens to fire
while a client is listening. This is a real, accepted limitation of the
current native API, not a gap this protocol is introducing or hiding: it is
exactly the "stale/expired" condition a client is already expected to
handle by disabling actions it can no longer trust, the same way an offline
connector already disables other time-sensitive controls.

## Threat analysis

- **First mutating, execution-gating capability.** Every prior addition
  changed only what a client can see; a permission reply changes what the
  agent is allowed to do next. The response enum is deliberately narrowed to
  `once`/`reject` specifically to bound the blast radius of any single
  reply to one action, never a standing rule.
- **Expanded disclosure boundary:** a request's description and pattern can
  reveal what the agent is about to do (a command, a file, a URL) to an
  authorized paired device that would not otherwise see it before the fact.
  This is the same category of intentional, bounded exception `chat.shell`
  already established for command/output — necessary for the human on the
  other end to make an informed approve/deny decision, not a claim that the
  fields are redacted of everything sensitive.
- **Confidentiality:** the request and reply travel only inside the existing
  authenticated end-to-end encrypted snapshot/stream and mutation channel.
  The server still routes opaque envelopes and retains nothing; no new logs,
  metrics, or disk state are introduced.
- **Authorization and abuse:** a compromised, *already-paired* device
  replying to permissions on the user's behalf is the same accepted risk
  category the root `AGENTS.md` Trust Model already names explicitly ("a
  malicious client build") — this capability does not introduce a new class
  of device compromise, only a new thing an already-trusted device could
  misuse. Existing account isolation, project/session membership,
  child-session verification, and revocation all apply unchanged; revoking
  a device's authorization stops it from replying like any other mutation.
- **Hostile content:** `operation` is a strict enum, `description`/`pattern`
  are bounded and sanitized exactly like every other description field in
  this protocol; nothing here evaluates as executable content on the
  client. Raw `metadata` and OpenCode's `"always"`/save-pattern fields never
  cross the boundary at all.
- **No new execution surface:** the reply operation calls only OpenCode's
  own permission-reply endpoint for a request OpenCode itself already
  created: it does not let a client invent a permission request, choose
  which tool runs, or bypass OpenCode's own evaluation of whether approval
  was required in the first place.

The shared `chat-permission-v1.json` fixture covers a bounded request with a
joined pattern and a private-looking metadata field that must never appear
in the projected output. Protocol tests cover strict field validation, the
opt-in/absent/null/object states, and that `"always"` (and near-miss typos)
are rejected before they could reach OpenCode. Plugin tests cover mapping
and sanitization from the native event, live capture/clear across both the
reply itself and another party resolving the same request, and the
authorization checks on the reply operation.
