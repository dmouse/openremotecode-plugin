# ADR 0016: OpenCode 2 tool presentation compatibility

Status: accepted

Update: [ADR 0018](0018-code-execution-presentation.md) adds an independent
opt-in for bounded code/results; summary-only clients retain this decision's
non-disclosure behavior.

## Context

The V2 connector reused the earlier tool presentation allowlist. The real V2
records inspected during diagnosis had `shell` with `input.command`, `read` with
`input.path`, `webfetch` with `input.url`, `execute` with `input.code`, and
`patch` with `input.patchText`. Existing integration tests had imported
synthetic `bash` and `read`/`filePath` records, so they did not exercise these
names and fields. Search remained visible because its `pattern` still matched.

## Decision

Map V2 `shell` to the negotiated `execute`/`chat.shell` presentation, and
`patch` to an edit activity with at most one sanitized filename from its
declared header. Accept `path` as well as `filePath` for read/edit/write.
Show only a parsed HTTP(S) hostname for webfetch and a fixed `Run code` label
for code-mode execute. Preserve older `bash` and `filePath` support.

Keep `execute` distinct from shell: it is code execution that may call other
tools and its output is not the bounded shell transcript exception. Read file
contents, patch hunks, fetch URLs and response bodies, code and results, and
all other tool metadata stay local. The mobile app still renders only the
versioned encrypted presentation fields. OpenCode's separate `shell` message
kind is not an assistant tool call and is not brought into chat history by
this change.

## Threat analysis and verification

Patch text is untrusted and potentially large: inspect at most its first 8,192
characters for an explicit file header, then apply the existing project-relative
path/basename sanitization. URLs can contain credentials, tokens and private
paths: parse only HTTP(S) values, emit at most a bounded hostname, and never
log any input. A hostname or filename can itself be sensitive, but travels
only in an authenticated end-to-end encrypted snapshot for the authorized
session. Unknown/malformed shapes degrade to a fixed summary, not raw content.

A shared V2-shaped fixture is asserted on both connector and mobile, including
non-disclosure of tool bodies. The connector's real-server integration test
imports V2-shaped calls and verifies the opt-in snapshot. Import is not a live
model-driven call, so changes to future tool schemas still need a new fixture
or a live end-to-end check.
