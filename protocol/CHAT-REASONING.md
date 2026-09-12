# Reasoning in chat snapshots

`chat.snapshot` version 1 optionally includes ordered `parts` on assistant
messages. `text` remains the concatenation of the text parts, preserving the
existing plain-text fallback. Clients render either the parts or that fallback,
never both. A plugin without reasoning support continues to return text-only
messages. Current mobile clients accept both forms; the web's separate
`session.list` interface is unaffected. This is an additive pre-release contract
update; strict TypeScript snapshot validators need the updated protocol package.

Each part has an opaque `id`, a `type` (`text` or `reasoning`), and `text`.
Reasoning optionally has `time: {start, end?}` in milliseconds. Times are
nonnegative safe integers and `end >= start`. Missing or invalid native clocks
are omitted. Consumers must not invent a duration or infer reasoning from normal
answer text. Only reasoning text exposed by the provider is displayed.

Parts follow OpenCode order. The plugin converts tool activity into the existing
text summary, with an opt-in [structured subtask extension](CHAT-SUBTASKS.md).
Provider metadata/signatures, other tool arguments/output, attachments,
and raw SDK objects are excluded. At most 100 parts and 48,000 UTF-16 text units
are retained per message, shared by answers and reasoning. `truncated` reports
the text or part limit. Part IDs must be unique within a message; fallback text
must agree with the text parts. Snapshot pagination and the mobile 200-message
history bound remain in effect.

## Threat analysis

Reasoning is sensitive conversation content and uses the same authorized
project/session snapshot path and authenticated encryption as answer text. It
adds no command, trust grant, server storage, log, metric, or audit field. The
plugin rechecks session membership around SDK reads; unauthorized project/session
combinations fail before content is returned. The client rejects malformed
parts, unsupported types, metadata fields, clocks, duplicate IDs and size limits.
Answers use the existing passive Markdown renderer; thought excerpts use plain
styled text. Images do not load and links cannot execute or launch. Content
remains in memory only.

The shared [fixture](test/fixtures/chat-reasoning-v1.json) is tested by the plugin,
TypeScript contract and Dart parser. Plugin integration uses synthetic reasoning
seeded only in a disposable OpenCode 1.18.30 database, then reads it through the
real SDK and encrypted relay. Android integration exercises the server relay,
native decryption, parser and passive thought rows in the isolated test application.
No external model/provider or developer conversation is needed.
