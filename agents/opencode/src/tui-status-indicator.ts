import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createElement, createTextNode, insertNode, setProp, type DomNode, type JSX } from "@opentui/solid"

import { FileConnectorAuthorizationStore, resolveConnectorAuthorizationPath } from "./auth/authorization-store.js"
import {
  FileConnectorConnectionStatusStore,
  resolveConnectorConnectionStatusPath,
} from "./connection-status-store.js"

type ChipState = "hidden" | "muted" | "success"

// Matches the ~3s leased-polling cadence used elsewhere for cross-process status (ADR 0007).
const POLL_INTERVAL_MS = 3_000

// The host may mount a slot's render function more than once over the plugin's lifetime
// (e.g. once per session visited), so a single shared poll loop drives every chip built,
// rather than each mount starting its own timer.
export function registerRemoteStatusChip(api: TuiPluginApi): () => void {
  const authorizationStore = new FileConnectorAuthorizationStore(resolveConnectorAuthorizationPath())
  const connectionStatusStore = new FileConnectorConnectionStatusStore(resolveConnectorConnectionStatusPath())
  const chips: { box: DomNode; dot: DomNode }[] = []
  let state: ChipState = "hidden"

  const computeState = async (): Promise<ChipState> => {
    const authorization = await authorizationStore.load().catch(() => undefined)
    if (!authorization || Date.parse(authorization.credentialExpiresAt) <= Date.now()) return "hidden"
    const status = await connectionStatusStore.load().catch(() => undefined)
    return status?.connected ? "success" : "muted"
  }

  const applyState = (): void => {
    const color = state === "success" ? api.theme.current.success : api.theme.current.textMuted
    for (const chip of chips) {
      setProp(chip.box, "visible", state !== "hidden")
      setProp(chip.dot, "style", { fg: color })
    }
  }

  const refresh = async (): Promise<void> => {
    state = await computeState()
    applyState()
  }

  const buildChip = (): JSX.Element => {
    const box = createElement("box")
    setProp(box, "flexDirection", "row")
    setProp(box, "gap", 1)
    setProp(box, "alignItems", "center")
    setProp(box, "flexShrink", 0)
    setProp(box, "visible", state !== "hidden")

    const text = createElement("text")
    setProp(text, "fg", api.theme.current.text)

    const dot = createElement("span")
    setProp(dot, "style", { fg: state === "success" ? api.theme.current.success : api.theme.current.textMuted })
    insertNode(dot, createTextNode("⊙ "))

    insertNode(text, dot)
    insertNode(text, createTextNode("Remote"))
    insertNode(box, text)

    chips.push({ box, dot })
    return box as unknown as JSX.Element
  }

  api.slots.register({
    slots: {
      home_prompt_right: buildChip,
      session_prompt_right: buildChip,
    },
  })

  const timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
  timer.unref()
  void refresh()

  return () => { clearInterval(timer); }
}
