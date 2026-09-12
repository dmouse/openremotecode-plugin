# Prompt Mode v1

`chat.prompt` accepts the strict body `{ version: 1, projectId, sessionId,
text, mode? }`. `mode` is exactly `"build"` or `"plan"`; null, other values,
arbitrary `agent` names, and extra SDK arguments are rejected. The response
remains `{ version: 1, accepted: true }`: acceptance is not model completion.

## Compatibility

`chat.prompt.mode` is a separate capability marker advertised alongside
`chat.prompt` when the connector has a chat adapter. It is not callable:
dispatching it returns `unsupported_operation`. Callable operations and
`ChatOperation` still derive only from `chatRequests`.

Mobile should offer explicit Build/Plan selection only when the active
connector advertises both capabilities. Send the choice as `mode` inside the
encrypted `chat.prompt` body, never as an operation or outer relay field.
Without the marker, omit `mode` and do not promise an explicit selection.
Older strict connectors reject the new field. Existing text-only clients remain
valid: omission sends no SDK `agent`, leaving OpenCode's existing local agent
selection behavior intact; it does not force Build. Recheck capabilities after
reconnect. Do not retry a prompt automatically, including by removing `mode`
after a failure or uncertain outcome. Protocol and chat versions remain 1.

## Threat Analysis

- Agent choices are bounded to the local `build` and `plan` agents. The adapter
  validates and explicitly constructs `promptAsync.body.agent` and text parts;
  it never spreads remote payloads into SDK arguments.
- Plan is governed by local OpenCode agent configuration and permissions, not
  a security sandbox or a guarantee of read-only execution. Local overrides
  can change either agent's behavior. This marker promises field support, not
  agent availability, model availability, or a particular permission policy.
- No new direct shell, filesystem, configuration, or persistent permission
  grants are exposed. Existing project/session authorization, child-session
  rejection, trusted-device authentication, deadlines, replay rejection and
  bounded mutation deduplication still apply. Changing mode under an existing
  request ID is conflicting reuse and does not execute another prompt.
- Mode and text travel only inside the authenticated encrypted payload. No
  plaintext payloads, agent choices, or SDK errors are added to logs or outer
  metadata. Failures retain fixed encrypted errors; mutations are not retried.

## SDK Validation

The supplied legacy `@opencode-ai/sdk` client is pinned to 1.18.30. Its
`SessionPromptAsyncData.body.agent` is optional string and its acceptance is
an empty HTTP 204. The adapter narrows the string to the two validated choices
and checks status rather than requiring non-null response data.
Context7's current [SDK docs](https://opencode.ai/docs/sdk) and
[agent configuration docs](https://opencode.ai/docs/agents) were checked;
installed types and isolated runtime tests are authoritative for the pin.
Tests use disabled providers and synthetic local messages, not paid model calls.
The encrypted runtime test verifies persisted `build`/`plan` user-message agents,
empty-204 acceptance, child rejection, invalid mode/agent rejection without native
message creation, and omission using the fixture's local
default (Build), rather than inheriting its previous Plan message's agent.
