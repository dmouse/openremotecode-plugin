# Read-Only Project MCP Status

The wire contract and threat analysis live in
`packages/protocol/PROJECT-MCP.md` at the workspace root. This feature does not
add fields to chat snapshots and never invokes MCP tools or mutation methods.

## Integration Seams

- `ProjectMcpReader.readProjectMcp(projectId, signal)` is the adapter seam.
  `src/opencode/mcp.ts` implements it for the TUI-provided OpenCode 2 client.
  It shares chat's opaque project registry and checks canonical
  directory/device/inode membership before and after the native read. It resolves
  the location before calling `mcp.list` for that directory, verifies the returned
  location, and copies only validated names and statuses. Pending or unknown
  native states produce `unavailable`, never a partial or empty-ready list.
- `readProjectMcp(reader, projectId, signal)` in `src/project-mcp.ts` supplies a
  shared ten-second deadline, cancellation race, strict response/project validation,
  and sanitized unavailable results for non-authorization failures.
- `ProjectMcpSubscriptions(reader, send, now?)` handles active-only polling,
  bounded subscriptions/renewals, revisions, lease expiry and cancellation. Its
  asynchronous `send(update, signal)` must honor cancellation before delivery and
  return false when delivery cannot be safely accepted. Production sends encrypt
  in the dispatcher and synchronously enter the bounded relay socket buffer.
- `CommandDispatcher` accepts optional `mcp: ProjectMcpReader`, independently of
  `chats`, and advertises `project.mcp.*` only when one is supplied. Use
  `attachRelay(sendEncryptedEnvelope)` after admission; it returns the disconnect
  callback. A new attachment invalidates the previous one. `dispose()` cancels it.
- `RelayConnection.onReady(send)` is called only once a socket is admitted and
  returns a cleanup callback. Its sender is bound to that socket generation and
  rejects/disconnects on saturation. Request replies use the same bounded sender.
- `src/connector.ts` wires these seams for development and authenticated relays.

## Verification

Run `pnpm --dir packages/protocol test` and `pnpm --filter @openremotecode/opencode test:unit` from the
workspace root. MCP unit coverage is in `test/unit/project-mcp-*.test.mjs`, with
transport lifecycle/buffer checks in `test/unit/relay-connection.test.mjs`.
