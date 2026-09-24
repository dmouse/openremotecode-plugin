import type { TuiContext } from "./setup.js";

/// The Remote indicator: the chip, state and polling in src/tui-status-indicator.ts, claimed on
/// OpenCode's footer status slots and colored from its theme tokens.
///
/// The chip module is imported lazily because it imports `@opentui/solid`, which only a TUI host
/// provides -- and it must be the host's copy, since an element built by another copy belongs to
/// a renderer that is not drawing this screen. The TUI host supplies it to plugins (verified
/// against 2.0.14: a plugin directory with no dependencies of its own resolves the bare import
/// and its elements render). The server host never reaches this code.
export async function registerStatusChip(context: TuiContext): Promise<() => void> {
  const slot = context.ui.slot;
  const theme = context.theme;
  if (!slot || !theme) return () => undefined;
  const { startRemoteStatusChip } = await import("../tui-status-indicator.js");
  const releases: (() => void)[] = [];
  const stop = startRemoteStatusChip({
    colors: () => ({ success: theme.text.feedback.success.base, muted: theme.text.muted, text: theme.text.base }),
    claim: (render) => {
      // Home screen and session prompt footers, beside the prompt.
      releases.push(slot({ append: "home.footer.status", render }), slot({ append: "prompt.footer.status", render }));
    },
  });
  return () => {
    stop();
    for (const release of releases) release();
  };
}
