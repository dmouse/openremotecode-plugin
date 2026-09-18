# ADR 0012: Abandoned Activity Parts

## Status

Accepted and implemented in the plugin. No protocol or mobile change was required.

## Context

A run that is interrupted — the operator stops it, or OpenCode exits its loop while a tool
call is still open — writes no terminal state for the part it was in the middle of. The part
keeps the `running` (or `pending`) status it was stored with, and the assistant message that
holds it never gets a `time.completed`. OpenCode's own TUI does not notice, because it draws
its working indicator from the session's live status, not from stored parts.

The remote client does read those parts. `activityFor` mapped a tool part's native status
straight through, so an abandoned part was published as `{ state: "running" }` forever, and
the mobile conversation's `isWorking` — which treats any running activity as live work —
kept the typing indicator and the stop affordance on a chat that had been finished for days.
Reopening the chat, reconnecting, or restarting OpenCode did not clear it: the stale state is
in OpenCode's storage, so every fresh snapshot reproduced it.

This was observed on a `question` tool call: the operator interrupted the agent while it was
asking, the run exited, and the stored part stayed `running` with the session reporting
`idle`.

`messageFinished`, which already retires an unfinished reasoning part, does not help here.
The interrupted message is itself unfinished, so the flag is false exactly when the part is
abandoned.

## Decision

- **The session's status decides, not the part's.** The plugin computes `sessionSettled`:
  the session is `idle`, no permission is pending, and no question is pending. That
  combination is what proves OpenCode will never move these parts again — an idle session
  with nothing waiting on the operator has nothing left to write.
- **A settled session retires its non-terminal parts.** A tool part still `pending` or
  `running` is published as `cancelled`; an unfinished reasoning part becomes `unknown`, the
  same state `messageFinished` already produces. Terminal states are never rewritten.
- **`task` tools are excluded.** A background subtask keeps running while the session that
  spawned it is idle. Its liveness belongs to the child session's own status, which
  `resolveSubtasks` already reads, and to the `ChatSubtask.active` rule the client applies.
- **Blocked is not abandoned.** While a permission or a question is pending, the tool call
  waiting on it is genuinely live and is left alone. A pending question is only known from a
  live capture or the caller's negotiated fallback read (see ADR 0011); a caller that
  negotiated neither gets the raw stored state rather than a guess.
- **Nothing is rewritten in OpenCode.** The plugin does not repair OpenCode's storage. This
  is a presentation decision applied at the boundary where SDK types become product types,
  which is the only place that knows both the stored part and the live session status.

## Consequences

- A chat whose run was interrupted stops presenting as working the moment the client reads it
  again. The interrupted tool call shows as "Cancelled" rather than animating indefinitely.
- The rule costs no additional native read. The snapshot already fetches the session status,
  and the live projection already tracks status, permission and question from captured events.
- `cancelled` was already in the protocol's activity states but never produced; it now has a
  single, defined source.
- The raw `ChatTool.status` still reports what OpenCode stored. Only the normalized activity
  carries the judgment, so a client that wants the underlying fact can still see it.
- A client that negotiates neither `chat.questions` nor a live subscription keeps the old
  behavior, including the stuck indicator. The mobile client negotiates both.
