# Tool Presentation v1

The `chat.tools` capability is a presentation marker, not a callable operation.
New clients request `includeTools: true` in `chat.snapshot` and
`chat.subtask.snapshot` only when the active connector advertises the marker.
Omission or false preserves legacy plain-text tool summaries. Neither the inner
protocol version nor the chat version changes. Subtask negotiation is independent;
verified task parts take precedence over ordinary tool presentation.

Assistant parts may contain `{ id, type: "tool", text, tool }`. `text` retains the
legacy summary and participates in the existing concatenation invariant. `tool`
has exactly these bounded, validated presentation fields:

- `operation`: read, edit, write, search, list, execute, fetch, or tool.
- `description`: optional, nonempty, at most 256 UTF-16 units.
- `status`: pending, running, completed, error, or unknown.
- `durationMs`: optional nonnegative safe integer, derived only from valid
  completed/error start and end clocks. Missing or invalid clocks stay absent.
- `shell`: optional command/output presentation, only for `execute` and only
  with the additional [shell capability and opt-in](CHAT-SHELL.md).

The plugin normalizes known native operation names. Read/edit/write may expose
a short project-relative filename; external paths display only their basename.
Bash summaries expose their bounded description. Commands and output require the
separate `chat.shell` negotiation described in [CHAT-SHELL.md](CHAT-SHELL.md). Grep/glob expose the
search pattern (up to 160 UTF-16 units) and optional display location (up to 80),
within the existing 256-unit description field. They do not expose matched lines,
result files, or invented match counts. Other tools have no description in this
iteration. Known MCP/device actions and internal tools use fixed descriptions,
such as Capture screen, Inspect screen elements or Apply patch, without copying
arguments. Unknown tools retain the generic operation and a bounded, humanized
native tool name (already present in the legacy fallback), not native titles or
metadata. Control
characters and bidi overrides are removed from descriptions. Outside the negotiated shell exception, no native output,
error body, URL, arbitrary metadata, or input object is forwarded. Only the
explicitly allowlisted search pattern is included, not arbitrary tool arguments.
The existing 100-part and 48,000-text-unit limits, pagination, IDs, and relay
payload bounds remain in effect. Tools add no SDK reads or polling.

## File Mentions

OpenCode expands file mentions into synthetic text plus a file part. The plugin
filters text marked `synthetic` or `ignored` before applying display budgets,
for both new and legacy snapshots. Original authored text is preserved literally;
the UI never guesses based on text such as `[Tool: ...]` or `Called the Read tool`.
User file parts become a bounded, passive `[File: filename]` label (basename only,
or `File` if unavailable). URLs, embedded data, source metadata and file contents
are not sent. No extra file is read to produce the label. Assistant file parts
remain excluded. This is a display projection, not deletion or modification of
the authoritative local conversation or the model's file context.

The one exception is an inline image attachment under the separate, opt-in
[`chat.images`](CHAT-IMAGES.md) capability: a bounded, re-encoded preview may
replace the label (user role) or the exclusion (assistant role) for a file
part whose mime and inline data qualify. Every other file part, and every
image part when that capability is not negotiated, keeps the behavior
described above unchanged.

## Threat Analysis

- Filenames, search patterns and approved short descriptions expand the display-data allowlist;
  they may still be sensitive. They travel only inside authenticated encrypted
  snapshots and are not logged, persisted remotely, or added to outer metadata.
- Presentation does not authorize tool execution, file opening, shell access,
  configuration changes, or permission grants. Tool and file rows are passive;
  only independently verified subtasks retain their existing navigation action.
- Native messages and fields are untrusted. Only an explicit schema is emitted
  and accepted; arbitrary input/metadata objects and non-shell outputs/errors remain local.
  Shell command/output may itself contain sensitive content; its expanded trust
  boundary is documented in [CHAT-SHELL.md](CHAT-SHELL.md).
- Filtering synthetic text fixes expanded attachment dumps without a textual
  heuristic that could erase genuine user prose. Older running plugins must be
  restarted: a client cannot reliably remove already flattened content.
- Project/session membership, authenticated client trust, child-session checks,
  deadlines, replay protection and bounded histories remain unchanged. A stale
  running tool is labeled last known while offline or no longer active.

Shared fixtures and tests cover strict fields, old-client fallback, clocks,
synthetic expansion larger than the display budget, literal authored text,
unknown tools, and native file expansion through an encrypted snapshot against
the pinned OpenCode 1.18.30 runtime. Mobile tests cover the same fixture, passive
semantics, aligned rows, large text, message spacing and same-ID updates.
