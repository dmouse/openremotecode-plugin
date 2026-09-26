# Open Remote Code Plugin

This MIT-licensed package is the local OpenCode integration boundary for Open Remote Code. It loads inside a real OpenCode process, creates a persistent connector identity, completes account pairing, restores its local authorization on later launches, establishes an outbound authenticated relay connection, and serves encrypted chat operations through the client OpenCode supplies to its TUI plugin. It requires OpenCode 2.0.12 or newer; see [Supported operations](#supported-operations).

The plugin connects to `https://api.openremotecode.com` by default, so the plain package name is enough:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@openremotecode/opencode"]
}
```

Set `apiUrl` in the plugin entry of a project's `opencode.json` to select a different (for example self-hosted) Open Remote Code API service. Options go in an object entry:

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

Install a local build as a **plugin directory**, not as a config entry. OpenCode runs
plugins in two hosts and gives each a different file from the same directory: `index.js` to its
server host and `tui.js` to its TUI host. Only the TUI host carries the client, the toasts and the
`/remote` command, and only a directory under `<project>/.opencode/plugins/` (or
`<config>/opencode/plugins/`) is loaded in both -- a `plugins` entry in `opencode.json` reaches
the server host alone, where the connector can start but can serve nothing. Create the directory
with two re-export files (a symlink is not discovered):

```sh
mkdir -p .opencode/plugins/openremotecode
cd .opencode/plugins/openremotecode
printf '{"name":"openremotecode","version":"0.0.0","type":"module","main":"index.js"}' > package.json
echo 'export { default } from "/absolute/path/to/packages/agents/opencode/dist/index.js"' > index.js
echo 'export { default } from "/absolute/path/to/packages/agents/opencode/dist/tui.js"' > tui.js
```

For a local build from the workspace root, replace the package name with the package directory `./packages/agents/opencode`. The directory form is required, and the build must have been run: OpenCode resolves a directory as `<directory>/index.js` for its server host and `<directory>/tui.js` for its TUI host, reading neither `main` nor `exports`, so the package's two root entries are what it loads. A path pointing straight at a built file is refused with `configured plugin path must be a directory`, and a directory without a root `index.js` is skipped in silence -- no log line, no error. Verified against OpenCode 2.0.14. URL precedence is `apiUrl`, then `OPENCODE_REMOTE_SERVER_URL`, then the production default `https://api.openremotecode.com`. Omit `apiUrl` to keep using the environment variable. An explicitly empty, invalid, or non-string `apiUrl` rejects the remote connection and logs a configuration error while local OpenCode remains usable.

The URL must be an origin without credentials, paths, query parameters, or fragments. HTTPS and WSS are required by default, including on loopback. Every API operation rejects redirects. Relay admission accepts only the contract's `/v1/relay` path on the configured API origin. Configuration chooses a trusted pairing destination; review project plugin configuration before loading it. Stored authorization remains bound to its original service and is never sent to a different origin. To pair separate services, use separate `OPENCODE_REMOTE_DATA_DIR` directories for their local identities and authorization.

To connect to the local Compose stack, explicitly enable plaintext loopback transport in the shell that launches OpenCode:

```sh
export OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK=true
export OPENCODE_REMOTE_SERVER_URL=http://127.0.0.1:8080
opencode
```

Only the literal value `true` enables HTTP/WS, and only for `127.0.0.1`, `localhost`, or `[::1]`. Unset, empty, or `false` keeps HTTPS/WSS mandatory; other values reject configuration. The flag is read from the process environment, never from project plugin options. It covers pairing, restored credentials, TUI actions, and the development relay. It does not disable certificate verification, redirect rejection, or origin checks. Set it for each development launch; setting it only on the Compose server does not configure the locally running plugin.

For production, leave the flag unset; the default already targets `https://api.openremotecode.com`, and any other service needs an HTTPS `apiUrl` or `OPENCODE_REMOTE_SERVER_URL`. An HTTP authorization saved during development requires the opt-in again after restarting. See the [transport security decision](docs/adr/0004-transport-security.md).

First use starts a short-lived pairing authorization and displays the user code and safety code through OpenCode's TUI. Enter the code in the mobile app's **Add connection** screen. OpenCode then shows the safety code in a dialog asking whether to allow that phone to control it: approve only if the app shows the same code, then confirm in the app. The pairing cannot complete without this approval, so someone who only sees or guesses the pairing code cannot take control of OpenCode; declining cancels it and a new code follows. Pending authorization is stored in a separate `0600` file so restarting OpenCode during setup resumes the same code and transcript. The file is removed after completion or expiry. The resulting connector credential and trusted mobile identity are also stored under the Open Remote Code data directory with `0600` file permissions. Each reconnect acquires a fresh one-use WebSocket ticket.

`OPENCODE_REMOTE_RELAY_URL` plus `OPENCODE_REMOTE_TRUSTED_CLIENT_IDENTITY` remains a loopback-only test harness. A `ws://` harness URL also requires `OPENCODE_REMOTE_ALLOW_INSECURE_LOOPBACK=true`. The integration tests set this explicitly for their isolated development processes.

The plugin includes a versioned HPKE authenticated envelope using P-256, HKDF-SHA256, and AES-256-GCM. This cryptographic selection is provisional pending a production security review; see `docs/adr/0001-hpke-relay-envelopes.md`.

### Several projects on one computer

OpenCode loads the plugin once per project directory, and every instance shares the same connector identity. Only one instance holds the connection to the service at a time; the others wait and take over if it exits.

Directories are set up automatically. Each running instance announces its own directory in the private Open Remote Code data directory, and the connected instance serves every announced directory, so the app sees a project as soon as OpenCode is launched in it and stops seeing it when OpenCode exits there (a crashed instance is dropped within seconds). Where you install the plugin decides the scope:

- **Installed globally**, every folder you launch OpenCode in becomes available in the app.
- **Installed in one project** (`<project>/.opencode/plugins/`), only that project is available.

`projectDirectories` remains as an optional way to add exact absolute directories that no running instance announces:

```json
{
  "plugins": [
    {
      "package": "@openremotecode/opencode",
      "options": { "projectDirectories": ["/home/me/project-one", "/home/me/project-two"] }
    }
  ]
}
```

The app's **Open project by path** only opens a directory that is currently available this way.

## Revoking remote access

`/remote` uses OpenCode's own dialogs, and the **⊙ Remote** indicator sits in its footer status
slots. The indicator is shown while a valid authorization exists, green while the relay is
connected and muted otherwise. The dialog looks up a legacy authorization's linking date once
before opening the details rather than filling it in afterwards; every decision it makes,
revocation above all, is the one in `src/remote-access.ts`.

Run `/remote` and press Enter on **Active token** to open its service, connector, and expiration details. Choose **Back** to return, or **Revoke remote access** and confirm. The plugin stops its relay and removes its saved authorization and old connector key immediately, before contacting the service — a slow, offline, or misbehaving server can never keep the local relay running past a confirmed revoke. Your local OpenCode chats remain available. Restart OpenCode when you want a fresh pairing code. All plugin instances sharing the same `OPENCODE_REMOTE_DATA_DIR` share this authorization and are disconnected together.

Token details also show **Linked**, with the original pairing date and a relative age such as **3 days ago**. New pairings save the server-provided `linkedAt` timestamp locally. For older saved authorizations, the dialog requests the date from `GET /v1/connectors/self`; if the server is unavailable or predates this endpoint, it displays **Date unavailable**. Age is never inferred from expiration or file timestamps. The Active indicator uses OpenCode's success theme color.

Telling the service is best-effort on top of the local disable: if `POST /v1/connectors/self/revoke` cannot be reached, the credential is queued and retried automatically the next time OpenCode starts, with no action needed from you. If the initial staleness check fails instead — the linked connector changed underneath the dialog — nothing is revoked locally and the dialog offers Refresh so you can retry against the current state.

## Development

The package requires Node.js 24 or newer for development. Transport integration tests also require the `openssl` executable to generate disposable localhost certificates. These certificates are trusted only by isolated test clients; no private key fixtures are stored in the repository.

- `pnpm install` from the repository root installs workspace dependencies.
- `pnpm --filter @openremotecode/opencode build` creates the plugin artifact in `packages/agents/opencode/dist`.
- `pnpm --filter @openremotecode/opencode test` runs the unit and integration tests.
- `pnpm --filter @openremotecode/opencode test:unit` runs dispatcher, protocol, encryption, adapter, and identity-store tests.
- `pnpm --filter @openremotecode/opencode test:integration` runs the relay, revocation, transport, and real-OpenCode tests.
- `pnpm --filter @openremotecode/opencode pack:check` inspects the package archive.

Integration files run sequentially because concurrent cold OpenCode bootstraps
can exceed their activation deadlines. Unit tests retain parallel execution.

To run the real-OpenCode integration test, set `OPENCODE_TEST_BINARY` to an OpenCode executable
and `OPENCODE_CLIENT` to `@opencode/client`'s `dist/promise/index.js`; it is skipped otherwise.
OpenCode is published to npm, so both come from there. CI installs them this way, and the same
two commands work locally:

```sh
# in a scratch directory, not the workspace
npm install --ignore-scripts --no-package-lock @opencode/cli-linux-x64@2.0.12 @opencode/client@2.0.12

# in packages/agents/opencode, after pnpm run build
OPENCODE_TEST_BINARY=<scratch>/node_modules/@opencode/cli-linux-x64/bin/opencode \
OPENCODE_CLIENT=<scratch>/node_modules/@opencode/client/dist/promise/index.js \
  node --test --test-timeout=45000 test/integration/opencode-connector.test.mjs
```

`@opencode/cli` resolves the matching platform package in a postinstall step; depending on that
platform package directly keeps the install script-free and pinned. Substitute the package for
your own platform if it is not linux-x64.

## Supported operations

The connector runs in the TUI plugin and is available while a TUI is attached to the instance;
`opencode serve` on its own has no connector. It supports listing, opening and creating chats,
reading message history, subtasks, live activity state and image attachments, and live-streaming
updates (with pending permission and question requests, and tool/shell content when the client
opts in), listing available models, text prompts with Build/Plan mode and a chosen model and
  effort, abort and permission/question replies, full-history forking, and deletion
  of idle chats and their authorized children. Renaming and todos are not available
  and fail explicitly as unsupported -- todos have no discoverable OpenCode API at all.
  Read-only project MCP server status is available in Chat details while a trusted
  connector is online; it does not expose MCP tools, authentication, or configuration
  actions. A Build/Plan or model/effort choice switches the session's agent
or model, so the desktop TUI shows what the phone last used. Question and subtask support each rely on an
unconfirmed inference about OpenCode's own tools -- see
[ADR 0013](docs/adr/0013-opencode-2-tui-hosting.md) for what is and isn't verified, and
[ADR 0014](docs/adr/0014-opencode-2-only.md) for the removal of OpenCode 1.x support.

See the [authorized project contexts ADR](docs/adr/0002-authorized-project-contexts.md)
before extending session browsing or adding path entry. The legacy `session.list`
returns the newest 50 root sessions of the plugin's own directory; it does not expose
pagination or guarantee a complete list.
