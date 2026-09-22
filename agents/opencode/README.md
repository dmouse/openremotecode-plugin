# Open Remote Code Plugin

This MIT-licensed package is the local OpenCode integration boundary for Open Remote Code. It loads inside a real OpenCode process, creates a persistent connector identity, completes account pairing, restores its local authorization on later launches, establishes an outbound authenticated relay connection, and serves an encrypted, read-only `session.list` operation through the supplied SDK client.

The plugin connects to `https://api.openremotecode.com` by default, so the plain package name is enough. OpenCode 1.x reads the `plugin` key:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@openremotecode/opencode"]
}
```

OpenCode 2.x renamed the key to `plugins`. The package itself is the same; see [OpenCode 2](#opencode-2) for what the connector supports there:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@openremotecode/opencode"]
}
```

Set `apiUrl` in the plugin entry of a project's `opencode.json` to select a different (for example self-hosted) Open Remote Code API service. On 1.x this is a `[plugin, options]` tuple:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@openremotecode/opencode", { "apiUrl": "https://remote.example.com" }]
  ]
}
```

On 2.x the same options go in an object entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@openremotecode/opencode",
      "options": { "apiUrl": "https://remote.example.com" }
    }
  ]
}
```

For a local build from the workspace root, replace the package name with `./packages/agents/opencode/dist/index.js` on 1.x, or with the package directory `./packages/agents/opencode` on 2.x. The directory form matters on 2.x: the connector runs in the TUI plugin, which OpenCode resolves through the package's own `./tui` export, so an entry pointing straight at a single built file only reaches the (inert) server side. OpenCode 1.18.30 supports the `[plugin, options]` format. URL precedence is `apiUrl`, then `OPENCODE_REMOTE_SERVER_URL`, then the production default `https://api.openremotecode.com`. Omit `apiUrl` to keep using the environment variable. An explicitly empty, invalid, or non-string `apiUrl` rejects the remote connection and logs a configuration error while local OpenCode remains usable.

The URL must be an origin without credentials, paths, query parameters, or fragments. HTTPS and WSS are required by default, including on loopback. Every API operation rejects redirects. Relay admission accepts only the contract's `/v1/relay` path on the configured API origin. Configuration chooses a trusted pairing destination; review project plugin configuration before loading it. Stored authorization remains bound to its original service and is never sent to a different origin. To pair separate services, use separate `OPENCODE_REMOTE_DATA_DIR` directories for their local identities and authorization.

To connect to the local Compose stack, explicitly enable plaintext loopback transport in the shell that launches OpenCode:

```sh
export OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK=true
export OPENCODE_REMOTE_SERVER_URL=http://127.0.0.1:8080
opencode
```

Only the literal value `true` enables HTTP/WS, and only for `127.0.0.1`, `localhost`, or `[::1]`. Unset, empty, or `false` keeps HTTPS/WSS mandatory; other values reject configuration. The flag is read from the process environment, never from project plugin options. It covers pairing, restored credentials, TUI actions, and the development relay. It does not disable certificate verification, redirect rejection, or origin checks. Set it for each development launch; setting it only on the Compose server does not configure the locally running plugin.

For production, leave the flag unset; the default already targets `https://api.openremotecode.com`, and any other service needs an HTTPS `apiUrl` or `OPENCODE_REMOTE_SERVER_URL`. An HTTP authorization saved during development requires the opt-in again after restarting. See the [transport security decision](docs/adr/0004-transport-security.md).

First use starts a short-lived pairing authorization and displays the user code and safety code through OpenCode's TUI. Enter the code in the mobile app's **Add connection** screen, compare the safety codes, and confirm the match. Pending authorization is stored in a separate `0600` file so restarting OpenCode during setup resumes the same code and transcript. The file is removed after completion or expiry. The resulting connector credential and trusted mobile identity are also stored under the Open Remote Code data directory with `0600` file permissions. Each reconnect acquires a fresh one-use WebSocket ticket.

`OPENCODE_REMOTE_RELAY_URL` plus `OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY` remains a loopback-only test harness. A `ws://` harness URL also requires `OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK=true`. The bundled demo and integration fixtures set this explicitly for their isolated development processes.

The plugin includes a versioned HPKE authenticated envelope using P-256, HKDF-SHA256, and AES-256-GCM. This cryptographic selection is provisional pending a production security review; see `docs/adr/0001-hpke-relay-envelopes.md`.

### Several projects on one computer

OpenCode loads the plugin once per project directory, and every instance shares the same connector identity. Only one instance holds the connection to the service at a time; the others wait and take over if it exits. The connected instance serves its own directory plus the exact absolute directories in `projectDirectories`, so list every project you want to reach from the app, in the plugin entry of each project's `opencode.json`:

```json
{
  "plugin": [
    ["@openremotecode/opencode", { "projectDirectories": ["/home/me/project-one", "/home/me/project-two"] }]
  ]
}
```

The app's **Open project by path** only opens a directory that is already authorized this way. A project that is not listed is reachable only while its own instance holds the connection.

## Revoking remote access

Run `/remote` and press Enter on **Active token** to open its service, connector, and expiration details. Choose **Back** to return, or **Revoke remote access** and confirm. The plugin stops its relay and removes its saved authorization and old connector key immediately, before contacting the service — a slow, offline, or misbehaving server can never keep the local relay running past a confirmed revoke. Your local OpenCode chats remain available. Restart OpenCode when you want a fresh pairing code. All plugin instances sharing the same `OPENCODE_REMOTE_DATA_DIR` share this authorization and are disconnected together.

Token details also show **Linked**, with the original pairing date and a relative age such as **3 days ago**. New pairings save the server-provided `linkedAt` timestamp locally. For older saved authorizations, the dialog requests the date from `GET /v1/connectors/self`; if the server is unavailable or predates this endpoint, it displays **Date unavailable**. Age is never inferred from expiration or file timestamps. The Active indicator uses OpenCode's success theme color.

Telling the service is best-effort on top of the local disable: if `POST /v1/connectors/self/revoke` cannot be reached, the credential is queued and retried automatically the next time OpenCode starts, with no action needed from you. If the initial staleness check fails instead — the linked connector changed underneath the dialog — nothing is revoked locally and the dialog offers Refresh so you can retry against the current state.

## Development

The package requires Node.js 24 or newer for development and a locally installed OpenCode 1.18.30 executable for the black-box integration test. Transport integration tests also require the `openssl` executable to generate disposable localhost certificates. These certificates are trusted only by isolated test clients; no private key fixtures are stored in the repository.

- `pnpm install` from the repository root installs workspace dependencies.
- `pnpm --filter @openremotecode/opencode build` creates the plugin artifact in `packages/agents/opencode/dist`.
- `pnpm --filter @openremotecode/opencode demo:connection` launches real OpenCode and demonstrates an encrypted round trip with a local simulated client.
- `pnpm --filter @openremotecode/opencode test` runs dispatcher, envelope, identity, authorization persistence, and real-OpenCode integration tests.
- `pnpm --filter @openremotecode/opencode test:unit` runs dispatcher, protocol, encryption, and identity-store tests.
- `pnpm --filter @openremotecode/opencode test:integration` runs real OpenCode relay, authorization, and project compatibility tests.
- `pnpm --filter @openremotecode/opencode test:projects` validates project/workspace scope, paginated sessions/history, and plugin lifecycle against OpenCode 1.18.30. Set `OPENCODE_TEST_BINARY` to a separate pinned executable if your interactive version differs.
- `bun test packages/agents/opencode/test/unit/tui-revocation.test.mjs -t 'Active is rendered'` verifies the status color with OpenTUI's native renderer after building. OpenTUI 0.4.5 needs Bun for this check; Node skips it.
- `pnpm --filter @openremotecode/opencode pack:check` inspects the package archive.

The integration test uses temporary OpenCode configuration and data directories, loads the built plugin through OpenCode's normal plugin configuration, creates a real session, and verifies that the encrypted response matches OpenCode's authoritative API before removing all temporary state.

Integration files run sequentially because concurrent cold OpenCode bootstraps
can exceed their activation deadlines. Unit tests retain parallel execution.

## OpenCode 2

OpenCode 2.x is supported in a first milestone. The same package loads on 1.x and 2.x; on 2.x the
connector runs in the TUI plugin and is available while a TUI is attached to the instance. It
supports listing, opening and creating chats, reading message history, subtasks, live activity
state and image attachments, and live-streaming updates (with pending permission and question
requests, and tool/shell content when the client opts in), listing available models, text
prompts, abort and permission/question replies; todos and prompt-time model/agent selection are
not yet available and fail explicitly as unsupported -- todos have no discoverable v2 API at all.
Question and subtask support each rely on an unconfirmed inference about OpenCode 2's own tools --
see [ADR 0013](docs/adr/0013-opencode-2-tui-hosting.md) for what is and isn't verified. See
[ADR 0013](docs/adr/0013-opencode-2-tui-hosting.md).

Configure the plugin on 2.x with `"plugins"` (not `"plugin"`), and point a local build at the
package directory rather than at `dist/index.js`, so OpenCode resolves the `./tui` export the
connector actually runs in. See the configuration examples at the top of this file.

To run the OpenCode 2 integration test, set `OPENCODE_V2_TEST_BINARY` to an OpenCode 2
executable and `OPENCODE_V2_CLIENT` to `@opencode/client`'s `dist/promise/index.js`; it is skipped
otherwise. OpenCode 2 is published to npm rather than to the GitHub releases the 1.x installer
reads, so both come from there. CI installs them this way, and the same two commands work locally:

```sh
# in a scratch directory, not the workspace
npm install --ignore-scripts --no-package-lock @opencode/cli-linux-x64@2.0.12 @opencode/client@2.0.12

# in packages/agents/opencode, after pnpm run build
OPENCODE_V2_TEST_BINARY=<scratch>/node_modules/@opencode/cli-linux-x64/bin/opencode \
OPENCODE_V2_CLIENT=<scratch>/node_modules/@opencode/client/dist/promise/index.js \
  node --test --test-timeout=45000 test/integration/v2-connector.test.mjs
```

`@opencode/cli` resolves the matching platform package in a postinstall step; depending on that
platform package directly keeps the install script-free and pinned. Substitute the package for
your own platform if it is not linux-x64.

See the [current compatibility findings](docs/opencode-1.18.30-validation.md)
and [original project investigation](docs/opencode-1.18.25-project-validation.md)
and [authorized project contexts ADR](docs/adr/0002-authorized-project-contexts.md)
before extending session browsing or adding path entry. The current `session.list`
returns OpenCode's default first 100 sessions; it does not yet expose pagination
or guarantee a complete list. Multiple directory instances also share one key,
so production endpoint routing must be extended before project switching.
