# ADR 0008: Negotiated read-only shell history

Status: Accepted

## Context

Native OpenCode shell invocations create a synthetic-only user message and a bash
tool without a description. The summary-only projection left empty user entries
and icon-only tool rows on mobile, with no command or output available to inspect.
Users need to see executed commands and their results and collapse each pair.

## Decision

Introduce the optional `chat.shell` presentation capability and explicit snapshot
opt-in, layered on `chat.tools`. Project only bounded command and output strings
from native bash parts, without broadening the remote operation allowlist. Mobile
renders passive selectable text behind a per-command collapse control, expanded
initially. Generic collapsed headers retain status without a content preview.

The [shell contract and threat analysis](../../../../protocol/CHAT-SHELL.md)
define the approved disclosure exception, strict field and aggregate limits,
compatibility, lifecycle, failure behavior and tests. Synthetic-only records remain
in authoritative snapshots but do not create empty mobile message entries.

## Consequences

Both plugin and mobile must support the capability to display details; older peers
keep summaries. Authorized mobile devices can see sensitive content present in
shell history, inside the existing end-to-end encryption boundary. Collapsing is
a presentation choice, not redaction or deletion. No shell command execution,
output-file fetching, plaintext telemetry or durable mobile history is introduced.
