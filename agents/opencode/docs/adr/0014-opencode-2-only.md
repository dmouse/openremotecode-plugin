# ADR 0014: OpenCode 2 Only

## Status

Accepted. Supersedes the dual-generation packaging in [ADR 0013](0013-opencode-2-tui-hosting.md).

## Context

ADR 0013 shipped one package for both OpenCode generations: each entry exported both the 1.x
hook shape and the 2.x `setup` definition, and the plugin carried two chat adapters, two TUI
integrations, and the 1.x SDK as a development dependency. OpenCode 2 is now available, and
maintaining the 1.x path doubled the adapter surface this plugin has to keep secure and tested.

## Decision

The plugin supports OpenCode 2 only (`engines.opencode` `>=2.0.12 <3`).

- `dist/index.js` is `{ id, setup }` with an inert `setup`; `dist/tui.js` is `{ id, setup }` and
  starts the connector. The 1.x `server` and `tui` hooks are gone.
- The 1.x chat adapter, its live-parts overlay and raw SSE event shim, the 1.x history reader,
  the OpenTUI `/remote` dialog, and the 1.x-only `chat/*` helpers are removed.
- The OpenCode adapter lives in `src/opencode/` (formerly `src/v2/`), with the `V2` prefixes
  dropped from its names.
- The presentation layer reads a local normalized part shape (`src/message-parts.ts`) instead
  of the 1.x SDK's generated types, so `@opencode-ai/sdk` and `@opencode-ai/plugin` are no
  longer dependencies. The plugin still depends on no OpenCode package.
- Tests and CI run against OpenCode 2 only. The end-to-end revocation test drives the TUI
  `setup` entry instead of the 1.x server hook.

## Consequences

The connector no longer offers these capabilities, which only the 1.x adapter implemented:
`chat.rename`, `chat.fork`, `chat.delete`, `chat.todos`, and `project.mcp.*`. A client that
sends one gets `unsupported_operation`, as it already did against a 2.x connector. Model and
effort selection (`chat.prompt.model`) was restored on OpenCode 2 through `session.switchModel`;
see the update in ADR 0013. The dispatcher, `src/project-mcp.ts`, and their tests stay, so an OpenCode 2
implementation of `ProjectMcpReader` only has to supply the reader.

The connector runs only while a TUI is attached, so `opencode serve` alone has no connector.
The multi-instance and restart integration tests that drove a headless 1.x server are removed.
The instance lock remains covered by unit tests.

## Subsequent MCP status support

The OpenCode 2 TUI adapter now implements the read-only `ProjectMcpReader` using
the TUI-provided `mcp.list` client call. It advertises `project.mcp.*` under the
existing v1 product contract, after the same project authorization checks as
chat. The earlier unsupported-capability statement records the state when this
ADR was accepted; it no longer applies to project MCP status.

## Subsequent chat mutations

The TUI adapter now also implements `chat.fork` and `chat.delete` through the
OpenCode 2 client. Their authorization and verification rules are recorded in
[ADR 0015](0015-opencode-2-fork-delete.md). The unsupported-capability list
above remains a record of the original migration, not the current capability
advertisement.

Earlier ADRs keep their record of the 1.x behavior as it was decided at the time. Only ADR 0013's
status and a link in ADR 0002 to the removed 1.x validation notes are updated.
