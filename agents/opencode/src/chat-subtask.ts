import type { Message, Part } from "@opencode-ai/sdk";
import type { ChatSubtask } from "@openremotecode/protocol";

// Count the same child-session tool parts the pinned TUI uses. A bounded latest
// page is a lower bound, never an exact count or an invented elapsed duration.
export function subtaskStats(messages: { info: Message; parts: Part[] }[], complete: boolean): NonNullable<ChatSubtask["stats"]> {
  let toolCalls = 0;
  let partCount = 0;
  for (const message of messages) {
    partCount += message.parts.length;
    if (partCount > 5000) throw new Error("Subtask part limit");
    toolCalls += message.parts.filter((part) => part.type === "tool").length;
  }
  const start = messages.find((message) => message.info.role === "user")?.info.time.created;
  const last = [...messages].reverse().find((message) => message.info.role === "assistant")?.info;
  const end = last?.role === "assistant" ? last.time.completed : undefined;
  const valid = complete && start !== undefined && end !== undefined &&
    Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(end) && end >= start;
  return { toolCalls, complete, ...(valid ? { durationMs: end - start } : {}) };
}
