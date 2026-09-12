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

## License

MIT
