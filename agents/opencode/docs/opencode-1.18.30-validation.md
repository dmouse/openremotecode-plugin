# OpenCode 1.18.30 compatibility

The runtime fixture, plugin package and root SDK are pinned to 1.18.30. The CLI
already installed on the development machine is this version. The original
[1.18.25 project findings](opencode-1.18.25-project-validation.md) remain as the
historical investigation; current integration checks run against 1.18.30.

## Embedded event transport

The published root SDK's `dist/gen/core/serverSentEvents.gen.js` calls global
`fetch(url, options)` directly, even when the plugin client has an injected fetch.
Its ordinary request implementation correctly invokes `opts.fetch(request)` and
request interceptors. An HTTP `opencode serve` fixture therefore failed to expose
the embedded TUI problem: it has a reachable URL, whereas the TUI can use an
in-process server transport.

`src/opencode-events.ts` contains a narrow fixed-GET `/event` compatibility shim
using the supplied SDK request transport and a bounded SSE reader. Remote callers
cannot select a URL or an SDK operation. Source reader cancellation and generic
errors preserve the existing subscription lifecycle and sensitive-data policy.

## Checks

From the workspace root:

```sh
pnpm --filter @openremotecode/opencode test
```

`OPENCODE_TEST_BINARY` may point to a separate 1.18.30 binary. The tests isolate
their HOME/XDG data and use synthetic content. `opencode-events.test.mjs` verifies
injected fetch, directory and auth-header preservation, cancellation and malformed
frame bounds while global fetch is disabled. `chat-stream.test.mjs` exercises real
1.18.30 reasoning updates, busy state, incremental answer text and final thoughts
through a loopback synthetic provider and encrypted relay. Native Android coverage
uses the separate integration app via `mobile/tool/test_local_android.sh`.

## Activation

Rebuilding a plugin does not replace the module already loaded into an active
OpenCode process. Quit and restart OpenCode to load the updated SDK/plugin. Existing
mobile credentials and pairing do not need to be cleared.
