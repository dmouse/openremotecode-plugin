# Code execution presentation v1

`chat.code` is a display capability, never a callable operation. Supporting
clients send `includeTools: true, includeCode: true` on `chat.snapshot`,
`chat.subtask.snapshot` and `chat.stream.subscribe` only when both capabilities
are advertised. `includeCode` without `includeTools` is invalid. Older clients
receive summary-only code calls; older connectors never receive the new flag.

An `execute` tool may carry `code: { source, output, truncated }`. All fields
are required: source and output are strings capped at 8,000 and 32,000 UTF-16
units respectively, and truncated is a boolean. Code and shell details are
mutually exclusive. Unknown fields and details on other operations are rejected.
Both strings count toward the existing 48,000-unit message budget. Shortened
details set both `code.truncated` and `message.truncated`. Existing part, page,
history, frame and relay limits remain unchanged.

The connector projects only the known `execute` tool's `input.code` and its
normalized textual result, or its available streaming/error text. Pending calls
have empty output. Terminal escape/control sequences and bidi overrides are
removed, preserving tabs and newlines. No referenced output file is opened.
Other inputs, metadata, tool output and skill contents remain local. Skill
summaries include only a sanitized, bounded skill name (`name`, or `id`).

Mobile uses the same collapsed execution row for shell commands and code, with
Code/Output headings for code and Command/Output for shells. Details are selectable
literal text, never evaluated, Markdown-rendered or fetched. Empty, waiting,
failed, offline and truncated states follow shell presentation. Collapse state
stays in bounded in-memory UI state, resets with history, and hides details from
both visible and accessibility trees. Adjacent tool calls, including code and
skills, share a compact group across assistant-message boundaries; blank text
does not split them. Prose, reasoning, images and delegated subtasks retain their
boundaries. Opening the group reveals the original contextual activity rows.

## Threat analysis

- Code and results can contain credentials, file contents and personal data.
  This is an intentional bounded disclosure to an already authorized paired
  client, not redaction. Collapsing details is not protection from a compromised
  device, authorized screen capture, or the model provider.
- Existing trust, account/project/session isolation, subtask ancestry and
  revocation checks remain authoritative. No execution endpoint, file-read
  capability, automatic permission reply or retryable mutation is introduced.
- Content remains inside authenticated E2EE snapshots and updates. The server
  routes opaque envelopes without retaining messages. No new telemetry, logs,
  disk caches or automatic clipboard writes contain these details.
- Strict fields and shared budgets bound hostile input. Literal rendering and
  control stripping prevent active content and display manipulation. Missing
  output does not invent a result, truncation is explicit, and transport failures
  keep existing content-free error handling.

The shared `chat-code-v1.json` fixture is asserted by protocol, connector and
mobile tests. Tests cover opt-in compatibility, streaming forwarding, strict
parsing, budgets, native states, skill names, compact grouping, live updates,
collapse, passive rendering and large-text accessibility.
