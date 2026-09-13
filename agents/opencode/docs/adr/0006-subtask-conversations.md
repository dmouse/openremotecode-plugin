# Read-only subtask conversations

Status: accepted

Task tool calls previously became `[Tool: task · completed]`, losing the child
conversation and its progress. OpenCode 1.18.25 exposes the description and agent
in task input and the child session ID in `state.metadata.sessionId`. Its TUI
counts child tool parts and measures first user to last completed assistant.
The supplied SDK supports the required session get/messages/status reads. The
[pinned Task renderer](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/tui/src/routes/session/index.tsx#L2136)
and an isolated real-SDK integration test validate these assumptions.

We add an explicitly negotiated, read-only capability with bounded enrichment,
described in [CHAT-SUBTASKS](../../../../protocol/CHAT-SUBTASKS.md). Native
task metadata is an untrusted hint. It becomes a navigable ID only after checking
the actual child session's parent and canonical workspace. Child chats stay out
of ordinary chat lists and mutation APIs. Mobile pushes a separate read-only
view, retaining the parent draft, messages and scroll position in memory.

## Threat analysis

| Threat | Control |
| --- | --- |
| Task metadata references a foreign workspace, sibling, or root session | Check exact child ID, immediate parent, and canonical directory before/after reads; omit unverified IDs and stats |
| A client guesses a child or changes its parent/cursor | Explicit request schema, authenticated trusted peer, authorized project handle, parent/child checks and cursor binding on every page |
| A fork copies task metadata pointing to the original parent's child | The immediate-parent check rejects the copied reference; the fork retains its task label without granting child access |
| Directory/session changes during a read | Recheck workspace inode/canonical path and session relationship before returning data |
| Read-only UI used to invoke mutations directly | Adapter rejects child snapshot access through the ordinary route and rejects child prompt/abort, alongside existing rename/fork/delete restrictions |
| Tool output, provider metadata or credentials leak | Allow only bounded description and agent strings, verified ID, normalized status and numeric stats; exclude raw prompt, tool output, errors, model and other metadata |
| Deep trees or long histories cause unbounded work | Eight child reads, latest 100 messages / 5,000 parts each, shared four-second enrichment deadline; no recursive enrichment; mobile route depth at most eight |
| Partial history or stale/offline status looks complete | Lower-bound counts, omitted duration for incomplete/running tasks, explicit offline/unknown/unavailable labels |
| Late replies or trust loss restore decrypted content | Existing request generations/disposal and trust-loss clearing apply to each child view; parent polling pauses while covered |

All descriptions, child messages, identifiers and statistics remain inside the
authenticated encrypted protocol. The server gains no content storage or new
API. No plaintext logging, audit fields, metrics, durable conversation cache or
new filesystem/network tool capability is introduced. Failures use existing
fixed protocol errors; unavailable enrichment reveals no failure detail.

Native checks run only with `mobile/tool/test_local_android.sh` and the separate
integration app. The ordinary mobile app retains its login and pairing keys.
