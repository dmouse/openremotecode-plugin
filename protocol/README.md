# @openremotecode/protocol

Platform-neutral encrypted protocol contracts for Open Remote Code: connector identity generation, HPKE-based envelope encryption, pairing/handshake messages, and the versioned Zod schemas for every operation exchanged between an OpenCode connector, the relay, and a client (chat, sessions, activity, project MCP status, and related capabilities).

This package has no transport, storage, or UI concerns. It is consumed by `@openremotecode/opencode` (the OpenCode plugin) and by client implementations that need to speak the same wire contract.

## Install

```sh
npm install @openremotecode/protocol
```

## Usage

```ts
import {
  generateConnectorIdentity,
  encryptRelayPayload,
  decryptRelayEnvelope,
  RELAY_PROTOCOL_VERSION,
} from "@openremotecode/protocol"
```

See `src/index.ts` for the full set of exported schemas and helpers, and the `CHAT-*.md` / `ACTIVITY.md` / `PROJECT-MCP.md` documents in this package for the protocol design behind each capability.

## Connection epochs

Relay protocol version 2 binds every envelope to the connection it was sealed in, so a
captured envelope cannot be replayed into a later one. Any client speaking this wire
contract must take part:

1. Generate a fresh nonce per relay connection with `generateRelayNonce()` and send it as
   `nonce` in `client.hello` / `connector.hello`.
2. On receiving the peer's hello, compute the shared epoch with `deriveRelayEpoch()`. The
   transcript is role-ordered, so both peers pass the connector's key ID and nonce first
   and derive the same value.
3. Pass that epoch to `encryptRelayPayload()` and `decryptRelayEnvelope()`. It is
   authenticated in the HPKE additional data, so an envelope from another epoch fails to
   decrypt rather than merely comparing unequal.
4. Number outgoing envelopes from zero within each epoch, and feed incoming sequence
   numbers to a per-epoch `ReplayWindow`. It refuses repeats while still accepting the
   reordering that concurrent sealing produces. Discard the window and reset the counter
   when the epoch changes; never carry either across a reconnect.

The relay validates only the shape of these fields. Freshness is enforced by the peers,
because the relay is an untrusted router. See
[server ADR 0011](../../server/docs/adr/0011-relay-connection-epochs.md) for the design and
threat analysis, and `test/fixtures/relay-epoch-v2.json` for the cross-language derivation
vectors a new client implementation should verify against.

## License

MIT
