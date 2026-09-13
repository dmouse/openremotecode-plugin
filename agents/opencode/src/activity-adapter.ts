import type { Part } from "@opencode-ai/sdk"
import type { Activity } from "@openremotecode/protocol"

// Host-specific names stay here, never in the mobile presentation registry.
export function activityFor(part: Part, messageFinished = false): Activity | undefined {
  if (part.type === "reasoning") {
    // Native reasoning parts can omit `time` despite the SDK's non-optional type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const { start, end } = part.time ?? {}
    const validStart = Number.isSafeInteger(start) && start >= 0
    const finished = validStart && typeof end === "number" && Number.isSafeInteger(end) && end >= start
    return { kind: "reasoning", state: finished ? "completed"
      : !messageFinished && validStart && end === undefined ? "running" : "unknown" }
  }
  if (part.type !== "tool") return undefined
  const kinds: Record<string, Activity["kind"]> = { bash: "execute", read: "read", write: "write", edit: "edit",
    apply_patch: "apply_patch", grep: "search", glob: "search", list: "list", webfetch: "fetch",
    todowrite: "update_tasks", task: "subtask" }
  const status = part.state.status
  // Object.hasOwn, not `?? "tool"`: part.tool is attacker-influenced and a
  // bracket lookup of "__proto__"/"constructor" must not resolve off-object.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by Object.hasOwn above
  return { kind: Object.hasOwn(kinds, part.tool) ? kinds[part.tool]! : "tool",
    state: status === "error" ? "failed" : ["pending", "running", "completed"].includes(status) ? status : "unknown" }
}
