# Read-Only Project MCP Status

The wire contract and threat analysis live in
`packages/protocol/PROJECT-MCP.md` at the workspace root. This feature does not
add fields to chat snapshots and never invokes MCP tools or mutation methods.

## Integration Seams

- `OpenCodeChatAdapter.readProjectMcp(projectId, signal)` implements
  `ProjectMcpReader` using the same opaque project registry as chat. It checks
  canonical directory/device/inode membership before and after the SDK call.
- `readProjectMcp(reader, projectId, signal)` in `src/project-mcp.ts` supplies a
  shared ten-second deadline, cancellation race, strict response/project validation,
  and sanitized unavailable results for non-authorization failures.
- `ProjectMcpSubscriptions(reader, send, now?)` handles active-only polling,
  bounded subscriptions/renewals, revisions, lease expiry and cancellation. Its
  asynchronous `send(update, signal)` must honor cancellation before delivery and
  return false when delivery cannot be safely accepted. Production sends encrypt
  in the dispatcher and synchronously enter the bounded relay socket buffer.
- `CommandDispatcher` accepts optional `mcp: ProjectMcpReader`, independently of
  `chats`. Set both to the same `OpenCodeChatAdapter` in production. Use
  `attachRelay(sendEncryptedEnvelope)` after admission; it returns the disconnect
  callback. A new attachment invalidates the previous one. `dispose()` cancels it.
- `RelayConnection.onReady(send)` is called only once a socket is admitted and
  returns a cleanup callback. Its sender is bound to that socket generation and
  rejects/disconnects on saturation. Request replies use the same bounded sender.
- `src/index.ts` wires these seams for development and authenticated relays.

## Pinned SDK

The supplied plugin client is `@opencode-ai/sdk` **1.18.30**, root entry point:

```ts
await client.mcp.status({ query: { directory: workspace.path }, signal })
```

The root generated SDK signature differs from current v2 documentation's flattened
parameters. Do not create a new SDK client, use a generic proxy, or replace the
supplied transport/authentication. The native response is a status map by server
name; `failed` and `needs_client_registration` may contain raw errors, which are
never copied. No reliable complete native status event stream is assumed.

## Verification

Run `pnpm --dir packages/protocol test` and `pnpm --filter @openremotecode/opencode test:unit` from the
workspace root. MCP unit coverage is in `test/unit/project-mcp-*.test.mjs`, with
transport lifecycle/buffer checks in `test/unit/relay-connection.test.mjs`.
The integration test `test/integration/project-mcp.test.mjs` starts the pinned
OpenCode runtime and an inert, local stdio MCP fixture with no callable tools or
provider access. It verifies native connected/disabled/failed states, encrypted
snapshots and updates, rejected remote mutations, unsubscribe, and explicit
resubscription after reconnect. Run it after building:

```sh
node --test --test-timeout=45000 test/integration/project-mcp.test.mjs
```

Run from `packages/agents/opencode`; set `OPENCODE_TEST_BINARY` to the OpenCode 1.18.30 executable
when the interactive version differs. The fixture isolates HOME/XDG configuration
and credentials, and deletes its temporary state after each run.
