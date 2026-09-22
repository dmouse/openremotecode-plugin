import type { Plugin } from "@opencode-ai/plugin";

import { OpenCodeChatAdapter } from "./chat-adapter.js";
import { startConnector } from "./connector.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";

/// OpenCode 1.x: the connector runs inside the server plugin, on the SDK client the host supplies.
export const OpenCodeRemotePlugin: Plugin = async ({ client, directory }, options = {}) => {
  const connector = await startConnector({
    options,
    log: async (level, message, extra) => {
      await client.app.log({
        body: {
          service: "opencode-remote",
          level,
          message,
          ...(extra ? { extra } : {}),
        },
      });
    },
    notify: async ({ title, message, variant, durationMs }) => {
      await client.tui.showToast({ body: { title, message, variant, duration: durationMs } });
    },
    adapters: () => {
      const chats = new OpenCodeChatAdapter(client, directory, options.projectDirectories);
      return { sessions: new OpenCodeAdapter(client), chats, mcp: chats, stream: chats };
    },
  });
  return connector.dispose ? { dispose: connector.dispose } : {};
};

// One module, two OpenCode generations. v1 reads `server`; v2 requires a definition with a `setup`
// function. OpenCode 2 gives a server plugin too little API to serve chats (no session listing or
// history), so its connector runs in the TUI plugin (see ./tui.ts) and this v2 setup does nothing.
const plugin = {
  id: "@openremotecode/opencode",
  server: OpenCodeRemotePlugin,
  setup: (): void => undefined,
};

export default plugin;
