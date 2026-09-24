// The model the chat last ran on, recovered from the newest assistant message's
// flattened modelID/providerID/variant (see message-history.ts). Only ever read,
// narrowed into the same bounded {providerID, modelID, effort?} shape chat.prompt
// and chat.models already use -- never the raw message object. See CHAT-MODEL.md.
export function lastAssistantModel(messages: readonly { info: unknown }[]):
    { providerID: string; modelID: string; effort?: string } | undefined {
  for (const { info } of [...messages].reverse()) {
    if (!info || typeof info !== "object" || (info as { role?: unknown }).role !== "assistant") continue;
    const providerID = (info as { providerID?: unknown }).providerID;
    const modelID = (info as { modelID?: unknown }).modelID;
    const variant = (info as { variant?: unknown }).variant;
    const bounded = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128;
    if (!bounded(providerID) || !bounded(modelID)) return undefined;
    return { providerID: providerID as string, modelID: modelID as string,
      ...(bounded(variant) ? { effort: variant as string } : {}) };
  }
  return undefined;
}
