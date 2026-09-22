import { startConnector, type ConnectorNotification } from "../connector.js";
import { OpenCodeV2ChatAdapter } from "./chat-adapter.js";
import type { V2Client } from "./client.js";
import { OpenCodeV2SessionReader } from "./session-reader.js";

/// The part of OpenCode v2's TUI plugin context the connector uses. v2 gives a server plugin only
/// a narrow, domain-scoped API (no session listing, no message history), while the TUI plugin
/// receives the complete client, so the connector lives on the TUI side and is active while a
/// TUI is attached to the instance. Structural, so the plugin needs no v2 package to build.
export interface V2TuiContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly location: { readonly directory: string } | undefined
  readonly client: V2Client
  readonly data: { readonly location: { default(): { readonly directory: string } } }
  readonly ui: { readonly toast: { show(options: {
    title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number
  }): void } }
}

/// Starts the connector for one v2 TUI and returns its cleanup. The v2 TUI has no plugin log
/// sink, so diagnostics below error level are dropped and errors surface once as a toast; the
/// connector's logging rules already forbid sensitive content in every message it emits.
export async function setupV2Connector(context: V2TuiContext): Promise<() => Promise<void>> {
  const directory = (context.location ?? context.data.location.default()).directory;
  const options = { ...context.options };
  const reported = new Set<string>();
  const connector = await startConnector({
    options,
    log: (level, message) => {
      if (level === "error" && !reported.has(message) && reported.size < 8) {
        reported.add(message);
        context.ui.toast.show({ title: "Open Remote Code", message, variant: "error", duration: 10_000 });
      }
      return Promise.resolve();
    },
    notify: (notification: ConnectorNotification) => {
      context.ui.toast.show({ title: notification.title, message: notification.message,
        variant: notification.variant, duration: notification.durationMs });
      return Promise.resolve();
    },
    adapters: () => {
      const chats = new OpenCodeV2ChatAdapter(context.client, directory, options.projectDirectories);
      return { sessions: new OpenCodeV2SessionReader(context.client, directory), chats, stream: chats };
    },
  });
  return async () => { await connector.dispose?.(); };
}
