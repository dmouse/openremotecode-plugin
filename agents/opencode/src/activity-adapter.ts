import type { Part } from "@opencode-ai/sdk";
import type { Activity } from "@openremotecode/protocol";

// Host-specific names stay here, never in the mobile presentation registry.
//
// `sessionSettled` means the caller has established that OpenCode is idle for
// this session with nothing waiting on the user. An interrupted run writes no
// terminal state for the part it was in the middle of, so that part stays
// "pending"/"running" in OpenCode's stored history forever -- see ADR 0012. A
// settled session proves nothing will ever move it again, so it is reported as
// cancelled (tools) or unknown (reasoning) instead of as live work.
export function activityFor(part: Part, messageFinished = false, sessionSettled = false): Activity | undefined {
  if (part.type === "reasoning") {
    // Native reasoning parts can omit `time` despite the SDK's non-optional type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const { start, end } = part.time ?? {};
    const validStart = Number.isSafeInteger(start) && start >= 0;
    const finished = validStart && typeof end === "number" && Number.isSafeInteger(end) && end >= start;
    return { kind: "reasoning", state: finished ? "completed"
      : !messageFinished && !sessionSettled && validStart && end === undefined ? "running" : "unknown" };
  }
  if (part.type !== "tool") return undefined;
  const kinds: Record<string, Activity["kind"]> = { bash: "execute", read: "read", write: "write", edit: "edit",
    apply_patch: "apply_patch", grep: "search", glob: "search", list: "list", webfetch: "fetch",
    todowrite: "update_tasks", task: "subtask" };
  const status = part.state.status;
  // `task` is excluded: a background subtask keeps running while the session
  // that spawned it is idle, and the child session's own status -- not the
  // parent's -- is what settles it (see resolveSubtasks).
  const abandoned = sessionSettled && part.tool !== "task" && (status === "pending" || status === "running");
  // Object.hasOwn, not `?? "tool"`: part.tool is attacker-influenced and a
  // bracket lookup of "__proto__"/"constructor" must not resolve off-object.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by Object.hasOwn above
  return { kind: Object.hasOwn(kinds, part.tool) ? kinds[part.tool]! : "tool",
    state: abandoned ? "cancelled" : status === "error" ? "failed"
      : ["pending", "running", "completed"].includes(status) ? status : "unknown" };
}
