# Todo Presentation v1

`chat.todos` is a display capability for OpenCode's own per-session task
list: the list the agent writes with its `todowrite` tool and a locally
attached TUI already shows beside the conversation. This capability lets a
supporting client see the same list and how much of it is done.

Like `chat.tools`, `chat.shell`, `chat.images` and `chat.activities` — and
unlike `chat.permissions` — it only ever changes what a client can *see*.
There is no todo mutation: a remote client cannot add, reorder, complete, or
clear a task. The agent owns its list.

## Negotiation

A supporting client requests `includeTodos: true` on `chat.snapshot`,
`chat.subtask.snapshot`, or `chat.stream.subscribe` only when the connector
advertises `chat.todos`. It is independent of every other opt-in — a todo is
not a message part, so no `.refine` dependency exists between them. Omitting
or disabling it preserves today's behavior exactly: no `todos` field at all.
The chat protocol remains version 1.

A snapshot may carry:

```json
{
  "todos": [
    { "id": "tod_1", "content": "Read the relay contract", "status": "completed" },
    { "id": "tod_2", "content": "Add the todo tab", "status": "in_progress" },
    { "id": "tod_3", "content": "Wire the banner", "status": "pending" }
  ]
}
```

`todos` is absent for a client that didn't opt in, `[]` when it did and the
session has no task list, and this shape when it has one. Items keep
OpenCode's own order — the agent writes the list as a whole, and its order is
the plan's order, not a client-side sort. At most 100 items cross the
boundary; ids are unique within one list.

`content` is the task's own text, bounded to 256 UTF-16 units with control
characters and bidi overrides stripped — the same sanitizer every other
description field in this protocol already uses. `status` is a strict
four-value enum: `pending`, `in_progress`, `completed`, `cancelled`.
OpenCode types its native `status` as a bare string, so an unrecognized value
maps to `pending` rather than being forwarded or dropping the item.

`id` identifies an item within one list, and is positional. The SDK's
generated `Todo` type declares an id, but the pinned 1.18.30 binary never
sends one: its own storage keys a todo by `(session, position)` and
`GET /session/{id}/todo` returns `{content, status, priority}` only —
confirmed against a live server, the same pinned-SDK-versus-binary mismatch
`CHAT-PERMISSIONS.md` documents for its event name. The plugin therefore
derives `todo-<index>` from the item's place in the list, preferring a native
id if a future build supplies one. Treat it as the item's position in *this*
list, not a durable task identity: the agent rewrites the list as a whole,
so the item at a given index can be a different task after a write.

**No other native field crosses this boundary.** In particular OpenCode's
`priority` is not forwarded: nothing in this product presents it, and the
rule here is a presentation allowlist, not a raw passthrough.

## Source and liveness

Unlike a pending permission, a session's todo list *is* readable on demand:
the plugin reads OpenCode's `GET /session/{id}/todo` on each snapshot, under
the same project/session authorization and child-session membership checks
the snapshot itself already performs. A cold snapshot therefore recovers the
list, with no dependency on having been subscribed when it was written.

While a client holds a `chat.stream.subscribe` lease, OpenCode's own
`todo.updated` event carries the complete replacement list; the plugin
captures it on the live subscription and projects it, so a task ticking over
to completed reaches the client without waiting for the next full read. The
event is a whole-list replacement, never a delta — a captured list always
supersedes a remembered one. A read failure yields `[]`, never a leaked
native error, exactly as `readProjectMcp` already does for MCP status.

## Threat analysis

- **Read-only.** No operation accepts a todo, so this capability adds nothing
  a client can *do*. It does not widen the mutating surface
  `chat.permissions` opened.
- **Expanded disclosure boundary:** a task list describes what the agent
  intends to do next, in the user's own words or the model's. This is the
  same category of intentional, bounded exception `chat.shell` established
  for command/output and `chat.permissions` for a request's description: it
  is the point of the feature, not a claim that the text is redacted of
  everything sensitive. It travels only inside the existing authenticated
  end-to-end encrypted snapshot/stream channel; the server still routes
  opaque envelopes and retains nothing.
- **Hostile content:** `content` is bounded and sanitized exactly like every
  other description field here, `status` is a strict enum, and the list is
  length-capped with unique ids enforced by the schema. Nothing in it
  evaluates as executable content on the client, and the client renders it
  as plain text, never as Markdown.
- **Resource bounds:** one additional bounded native read per snapshot,
  inside the snapshot's existing deadline. The live path adds no read at
  all — the event already carries the list.

The shared `chat-todos-v1.json` fixture captures the pinned binary's actual
response shape — id-less items — over a five-item list mixing every status, an
unrecognized native status, a bidi override in an item's text, and a
private-looking native field that must never appear in the projected output. Protocol tests cover strict field validation, the opt-in/absent/empty
states, and that ids must be unique. Plugin tests cover mapping and
sanitization from the native read, live capture and replacement from
`todo.updated`, and that the field stays absent without the opt-in. Mobile
tests cover strict parsing, the task tab's counts, and the banner.
