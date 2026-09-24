import { startConnector, type ConnectorNotification } from "../connector.js";
import { WorkspaceRegistry } from "../chat/workspace.js";
import { OpenCodeChatAdapter } from "./chat-adapter.js";
import type { OpenCodeClient } from "./client.js";
import { OpenCodeMcpReader } from "./mcp.js";
import { openRemoteDialog, remoteAccessStores } from "./remote-dialog.js";
import { OpenCodeSessionReader } from "./sessions.js";
import { registerStatusChip } from "./status-chip.js";

/// The dialog surface `/remote` draws on. OpenCode's dialogs are promise-based, so the flow is a
/// loop over awaited choices rather than a tree of rendered callbacks.
export interface DialogUI {
  readonly dialog: {
    select<Value>(options: { title: string; placeholder?: string;
      options: readonly { title: string; value: Value; description?: string; footer?: string }[] }): Promise<Value | undefined>
    confirm(options: { title: string; message: string }): Promise<boolean | undefined>
    alert(options: { title: string; message: string }): Promise<void>
  }
}

/// The part of OpenCode's TUI plugin context the connector uses. OpenCode gives a server plugin
/// only a narrow, domain-scoped API (no session listing, no message history), while the TUI plugin
/// receives the complete client, so the connector lives on the TUI side and is active while a
/// TUI is attached to the instance. Structural, so the plugin needs no OpenCode package to build.
export interface TuiContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly location: { readonly directory: string } | undefined
  readonly client: OpenCodeClient
  readonly data: { readonly location: { default(): { readonly directory: string } } }
  /// Registers commands, including slash and palette entries. Optional because a host that does
  /// not offer it must still get a working connector, only without `/remote`.
  readonly keymap?: { layer(input: () => { mode?: string; commands?: readonly KeymapCommand[] }): void }
  readonly ui: DialogUI & {
    readonly toast: { show(options: {
      title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number
    }): void }
    /// Claims a place in the host's slot tree: the always-mounted `app` slot (the one context a
    /// keymap layer can be registered from) and the footer status slots the Remote chip lives in.
    readonly slot?: (claim: { append: "app" | "home.footer.status" | "prompt.footer.status"; render: () => unknown }) => () => void
  }
  /// Theme tokens, as the host's renderer accepts them. Only the ones the Remote chip uses.
  readonly theme?: { readonly text: { readonly base: unknown; readonly muted: unknown
    readonly feedback: { readonly success: { readonly base: unknown } } } }
}

export interface KeymapCommand {
  readonly id?: string
  readonly title?: string
  readonly description?: string
  readonly group?: string
  readonly palette?: true
  readonly slash?: { readonly name: string; readonly aliases?: string[] }
  readonly run: () => false | Promise<void> | undefined
}

/// Starts the connector for one TUI and returns its cleanup. The TUI has no plugin log
/// sink, so diagnostics below error level are dropped and errors surface once as a toast; the
/// connector's logging rules already forbid sensitive content in every message it emits.
export async function setupConnector(context: TuiContext): Promise<() => Promise<void>> {
  const directory = (context.location ?? context.data.location.default()).directory;
  const options = { ...context.options };
  const reported = new Set<string>();
  // Registered before the connector starts, and independently of whether it does: `/remote`
  // carries the local kill switch, which must stay reachable precisely when the relay, the
  // service or the pairing is broken.
  const dialogs = new AbortController();
  // A UI convenience must never be able to take the connector down with it: registration threw
  // `Keymap.Provider is missing` on 2.0.14 when it was attempted outside a rendered component,
  // and that exception aborted setup before the connector ever started.
  let releaseCommand: () => void = () => undefined;
  try {
    releaseCommand = registerRemoteCommand(context, dialogs.signal);
  } catch (error) {
    context.ui.toast.show({ title: "Open Remote Code", variant: "warning", duration: 10_000,
      message: `The /remote command is unavailable: ${error instanceof Error ? error.message : String(error)}` });
  }
  // Same rule for the indicator: it reflects the connector, it must never be able to stop it.
  let releaseChip: () => void = () => undefined;
  try {
    releaseChip = await registerStatusChip(context);
  } catch {
    // Without the chip the connector and /remote still work; there is nothing to tell the user.
  }
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
    // Resolved lazily, so a host without dialogs still starts; pairing then cannot be approved
    // and fails closed rather than completing without consent.
    confirm: (question) => context.ui.dialog.confirm(question),
    adapters: () => {
      const registry = new WorkspaceRegistry(directory, options.projectDirectories);
      const chats = new OpenCodeChatAdapter(context.client, directory, options.projectDirectories, registry);
      return { sessions: new OpenCodeSessionReader(context.client, directory), chats,
        mcp: new OpenCodeMcpReader(context.client, registry), stream: chats };
    },
  });
  return async () => {
    dialogs.abort();
    releaseCommand();
    releaseChip();
    await connector.dispose?.();
  };
}

/// Registers `/remote`, returning its release. A keymap layer belongs to the component that
/// creates it, and `setup()` is not one -- registering from there fails with
/// "Keymap.Provider is missing" (2.0.14). The layer is therefore created inside a render, from a
/// claim on the always-mounted `app` slot that draws nothing.
function registerRemoteCommand(context: TuiContext, signal: AbortSignal): () => void {
  const keymap = context.keymap;
  const slot = context.ui.slot;
  if (!keymap || !slot) return () => undefined;
  const stores = remoteAccessStores();
  let open = false;
  // "global", not the default "base" mode: a base-mode layer is unreachable while the prompt has
  // focus, which is exactly where a slash command has to be offered (verified against 2.0.14 --
  // the same command is absent from slash completion without this and present with it).
  const commands = (): { mode: string; commands: readonly KeymapCommand[] } => ({
    mode: "global",
    commands: [{
      id: "opencode-remote.open",
      title: "Open Remote Code",
      description: "Manage pairing and revoke remote access",
      group: "Remote",
      palette: true,
      slash: { name: "remote" },
      run: async () => {
        // One dialog at a time: a second invocation while the first is open would revoke against
        // a status read before the first one acted.
        if (open) return;
        open = true;
        try {
          await openRemoteDialog(context.ui, stores, signal);
        } catch (error) {
          context.ui.toast.show({ title: "Open Remote Code", variant: "error",
            message: `Remote access dialog failed: ${error instanceof Error ? error.message : String(error)}`, duration: 10_000 });
        } finally {
          open = false;
        }
      },
    }],
  });
  return slot({ append: "app", render: () => { keymap.layer(commands); return null; } });
}
