// The entry OpenCode's plugin loader gives to the *server* host.
//
// A path entry is resolved as `<directory>/index.js` for the server and `<directory>/tui.js` for
// the TUI; the loader reads neither `main` nor `exports`, and a directory missing the file for a
// host is skipped there in silence -- no log line, no error (verified against OpenCode 2.0.14).
// The server host's context is the narrow one: no client for chats, no keymap, no dialogs. The
// connector therefore lives in ./tui.js, and this side stays inert, exactly as
// docs/adr/0013-opencode-2-tui-hosting.md decided.
export { default } from "./dist/index.js";
