import type { TuiPlugin } from "@opencode-ai/plugin/tui";

import { setupV2Connector, type V2TuiContext } from "./v2/setup.js";

// One module, two OpenCode generations. v1 reads `tui` and ignores unknown keys; v2 reads `setup`.
// The v1 interface (which needs OpenTUI) loads lazily so a v2 TUI never resolves it.
const tui: TuiPlugin = async (api, options, meta) => {
  const { default: v1 } = await import("./tui-v1.js");
  await v1.tui(api, options, meta);
};

const plugin = {
  id: "opencode-remote",
  tui,
  setup: (context: V2TuiContext) => setupV2Connector(context),
};

export default plugin;
