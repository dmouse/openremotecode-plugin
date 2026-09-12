# Shell Presentation v1

`chat.shell` is a display capability, not a callable operation. A supporting client
requests `includeTools: true, includeShell: true` on `chat.snapshot` and
`chat.subtask.snapshot` only when the connector advertises both `chat.tools` and
`chat.shell`. `includeShell: true` without `includeTools: true` fails validation.
Omitting or disabling `includeShell` preserves summary-only tool payloads, so older
clients never receive fields their strict parsers reject. Older connectors never
receive the new request field. The chat protocol remains version 1.

An `execute` tool may additionally contain:

```json
{
  "shell": {
    "command": "printf 'hello\\n'",
    "output": "hello\n",
    "truncated": false
  }
}
```

All three fields are required when `shell` is present. Command is at most 8,000
UTF-16 units and output at most 32,000. Empty strings are valid. Other operations
cannot contain `shell`; unknown fields fail validation. Command plus output count
toward the existing 48,000-unit message budget along with every part's text.
The top-level `message.text` still concatenates non-reasoning part summaries,
without duplicating shell details. A shortened shell sets both `shell.truncated`
and `message.truncated`. Existing 100-part, ten-message page, 200-retained-message
mobile, encryption and relay byte limits still apply; oversized encrypted
responses fail through the existing bounded-response path.

The pinned OpenCode `bash` tool supplies `state.input.command`. Completed output
comes from `state.output`; running output comes from `state.metadata.output`.
Failed tools use `metadata.output` when present, otherwise `state.error`.
Pending tools have empty output. No description is required for native `!` shell
invocations. The plugin never follows output-file paths or performs extra reads.
Native `metadata.truncated: true` is retained as a truncation notice. Terminal
escape/control sequences and bidi overrides are removed, retaining tabs/newlines;
this is a passive display projection, not a byte-for-byte terminal emulator.

Mobile starts each shell collapsed, with a bounded description/status header
(Run command when no description exists). Expanded command/output is selectable
monospace text. The per-command toggle removes both details from visible and
accessibility trees; the description stays visible. Header typography/icons and
running indicators follow [agent activities](ACTIVITY.md).
Status/timing stay visible, including explicit offline/last-known states.
Completed empty output says No output; pending/running empty output says Waiting
for output. Shortened content carries a notice. UI-owned collapse choices are
keyed by message/part IDs and retained during polling and off-screen recycling,
bounded to loaded history, and cleared on history reset/navigation. Empty projected
user records are hidden in presentation without removing native records or changing
pagination. No remote shell execution action is added.

## Threat analysis

- **Expanded disclosure boundary:** shell commands and output can contain secrets,
  filenames, file contents, and personal information. Authorized paired clients may
  now read these bounded fields from their authorized project's sessions. This is
  an intentional exception to the summary-only policy, not a claim of redaction.
- **Confidentiality:** details stay inside authenticated end-to-end encrypted
  snapshots. The server routes opaque envelopes and does not retain conversation
  history. No new logs, metrics, audit fields, disk caches, or clipboard writes
  are introduced. Mobile keeps details in bounded memory only. Collapsing is visual
  hiding, not deletion, transmission suppression, or protection from a compromised
  device or authorized screen capture.
- **Authorization:** existing client trust, account isolation, project/session
  membership, child-session verification, revocation and timeout checks apply.
  There is no new SDK endpoint exposed remotely, permission grant, shell execution,
  URL opener, arbitrary file read, or retryable mutation.
- **Hostile content/resource exhaustion:** strict typed fields and shared size
  budgets prevent unbounded new payloads. Literal selectable rendering never
  evaluates shell/HTML/Markdown or fetches links/images; terminal controls and bidi
  overrides cannot control the display. No arbitrary input/metadata object crosses
  the boundary. Existing queue, replay, frame and history limits remain in force.
- **Failures/observability:** failed shell tools show Failed and bounded available
  output/error text inside the encrypted content, never telemetry. Missing output
  does not invent a result; truncation is explicit. Transport/validation errors
  retain generic content-free failure handling and existing metrics.

The shared `chat-shell-v1.json` fixture covers native synthetic user markers and
descriptionless completed tools. Protocol/plugin/mobile tests cover negotiation,
strict parsing, budgets, running/completed/error projections, passive rendering,
collapse updates and accessibility. An isolated native OpenCode integration test
executes a synthetic local command and verifies the encrypted opt-in snapshot and
cross-project denial; it requires no provider credentials.
