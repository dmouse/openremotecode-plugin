# Subtask conversations

The `chat.subtask.snapshot` version 1 capability enables task presentation and
read-only child conversations. A client that sees this capability can send
`includeSubtasks: true` with `chat.snapshot`. Omitting the flag preserves the
existing text/reasoning response for earlier clients. Older connectors continue
to show their text tool summary. The web's `session.list` view is unaffected.

An assistant message can contain an ordered `subtask` part with `id`, `text`
(the plain-text tool fallback), and `task`. Its task record contains only:

| Field | Contract |
| --- | --- |
| `title`, `agent` | Plain strings, 1–512 and 1–64 UTF-16 units |
| `status` | `pending`, `running`, `retry`, `completed`, `error`, or `unknown` |
| `background` | Whether OpenCode reports a background task |
| `sessionId` | Optional verified child ID, 1–128 units |
| `stats` | Optional `{toolCalls, complete, durationMs?}` |

Fallback message text is the concatenation of all non-reasoning parts. Clients
render the ordered parts or the fallback, never both. Existing bounds of 100
parts, 48,000 text units per message, and 10 messages per snapshot apply. Unknown
fields, duplicate part IDs, invalid counters and unsupported types are rejected.
Task descriptions/agent names have their own per-field bounds above.

Stats count tool parts in the child's latest 100 messages, bounded to 5,000
parts. `complete: false` means older messages exist: display a lower bound such
as `15+ toolcalls` and omit duration. Duration is provided only for a completed
task with complete history and valid first-user / last-assistant-completed
timestamps. Busy/retry child status overrides a completed parent task call.
Missing timestamps never produce an invented duration.

Each parent snapshot enriches at most eight of its most recent task parts.
Child enrichment has a shared four-second deadline inside the ten-second
snapshot deadline and never recurses, retains a cache, or polls independently.
Failed, missing, over-limit, and unauthorized child reads leave a task row without
a child ID or stats; they do not expose SDK errors or discard the parent text.
Tasks outside the enrichment budget remain visible without an open action.

`chat.subtask.snapshot` accepts exactly `version`, `projectId`, `sessionId`,
`parentSessionId`, and optional `cursor`. It returns the standard snapshot shape,
including the verified `chat.parentId`, and supports nested task presentation.
Before and after reading content, the plugin verifies that both sessions belong
to the authorized canonical project directory and that the child's native
`parentID` equals the supplied parent. Cursors remain bound to project and child.
Ordinary `chat.snapshot` and all chat mutations reject child sessions. This
capability cannot create, prompt, abort, rename, fork, delete, or grant permissions
in a child conversation.

The shared [fixture](test/fixtures/chat-subtasks-v1.json) exercises the TypeScript
contract, plugin normalization and Dart parser. Integration seeds synthetic
tasks in a disposable OpenCode 1.18.30 database and verifies SDK reads through
the encrypted dispatcher. Native Android integration adds the production server
relay and native decryption in the separate integration application.

See [the threat analysis](../agents/opencode/docs/adr/0006-subtask-conversations.md).
