// The entry OpenCode's plugin loader gives to the *TUI* host, resolved as `<directory>/tui.js`
// next to the server's `<directory>/index.js` (verified against OpenCode 2.0.14; the loader reads
// neither `main` nor `exports`, and a missing file is skipped in silence).
//
// This is the host that matters: its context carries the full client the chat adapters need, the
// toast surface for pairing, and the keymap and dialogs `/remote` is built on. The server host
// has none of those, which is why the connector runs here. See
// docs/adr/0013-opencode-2-tui-hosting.md.
export { default } from "./dist/tui.js";
