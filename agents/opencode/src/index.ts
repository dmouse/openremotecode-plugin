// The server-side plugin. OpenCode gives a server plugin too little API to serve chats (no
// session listing or history), so the connector runs in the TUI plugin (see ./tui.ts) and this
// setup does nothing. See docs/adr/0013-opencode-2-tui-hosting.md.
const plugin = {
  id: "@openremotecode/opencode",
  setup: (): void => undefined,
};

export default plugin;
