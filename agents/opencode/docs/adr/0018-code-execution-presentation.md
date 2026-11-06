# 0018: Opt-in code history within tool activity groups

Status: Accepted

## Context

Mobile showed a generic Run code label with no inspectable code or output, and
skill loading omitted the skill name. Shell history already has an explicitly
negotiated, bounded read-only presentation boundary.

## Decision

Normalize OpenCode's `execute` tool as execution activity. Add the independently
negotiated `chat.code` display capability and `includeCode` flag, not a remotely
callable execution operation. Project only its bounded code and textual result
through the existing authorized encrypted snapshot/stream path. Preserve
summary-only behavior for clients that did not opt in.

Reuse mobile's collapsed shell-history presentation for code with accurate
Code/Output headings. Include code and skills in existing compact tool runs,
ignoring blank text but preserving prose and thinking boundaries. Skill loading
adds only the bounded name to its description, not the skill's contents.

## Consequences

Deploy the connector and mobile changes together to enable inspectable code.
Older peers remain compatible. Authorized clients can see code/result secrets
just as they can see shell-history secrets; no new execution or filesystem
authorization is granted. See [the protocol and threat analysis](../../../../protocol/CHAT-CODE.md).
