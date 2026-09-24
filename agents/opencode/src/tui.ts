import { setupConnector, type TuiContext } from "./opencode/setup.js";

const plugin = {
  id: "opencode-remote",
  setup: (context: TuiContext) => setupConnector(context),
};

export default plugin;
