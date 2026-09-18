import type { Provider } from "@opencode-ai/sdk";
import type { chatRequests } from "@openremotecode/protocol";
import type { z } from "zod";

export type ChatPromptRequest = z.infer<(typeof chatRequests)["chat.prompt"]>

// The pinned SDK's typed Model has no `variants` field -- it predates
// OpenCode's reasoning-effort "variant" concept -- but the pinned server's
// runtime response still carries it, keyed by variant id: on OpenCode
// 1.18.30, `variants` is a record `{ [variantId]: { reasoningEffort, ... } }`
// (confirmed against a live `GET /config/providers` response), not an array.
// Only the bounded keys ever cross this boundary; each key's own value -- the
// provider-specific request override it maps to internally -- never does.
// See CHAT-MODEL.md.
export function effortLevelsFor(model: unknown): string[] {
  const variants = model && typeof model === "object" ? (model as { variants?: unknown }).variants : undefined;
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) return [];
  const ids = Object.keys(variants).filter((id) => id.length > 0 && id.length <= 128);
  return [...new Set(ids)].slice(0, 10);
}

// AssistantMessage.modelID/providerID/variant exist on OpenCode 1.18.30's
// runtime message info (confirmed against a live session) but the pinned
// SDK's typed message shape doesn't declare them. Only ever read, narrowed
// into the same bounded {providerID, modelID, effort?} shape chat.prompt and
// chat.models already use -- never the raw message object. See CHAT-MODEL.md.
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

// Builds the OpenCode prompt body for chat.prompt. `getProviders` is only invoked when an
// effort level is actually requested, so a plain prompt never pays for a provider lookup.
export async function buildPromptRequestBody(prompt: ChatPromptRequest,
    getProviders: () => Promise<Provider[]>): Promise<Record<string, unknown>> {
  const sdkBody: Record<string, unknown> = { parts: [{ type: "text", text: prompt.text }] };
  if (prompt.mode === "build") sdkBody.agent = "build";
  if (prompt.mode === "plan") sdkBody.agent = "plan";
  if (prompt.model) {
    const { providerID, modelID, effort } = prompt.model;
    sdkBody.model = { providerID, modelID };
    if (effort) {
      // Re-validate against the model's currently reported variants before
      // forwarding -- never trust a stale client-asserted effort id, even
      // though the mobile client already only offers ids chat.models gave it.
      const providers = await getProviders();
      const model = providers.find((p) => p.id === providerID)?.models[modelID];
      if (!model || !effortLevelsFor(model).includes(effort)) {
        throw new Error("Unsupported reasoning effort for this model");
      }
      // `variant` is a top-level PromptInput field, a sibling of `model`/
      // `agent`/`parts` -- not nested under `model`. The pinned SDK's body
      // type predates it; OpenCode's own prompt schema (session/prompt.ts)
      // declares it as an optional string.
      sdkBody.variant = effort;
    }
  }
  return sdkBody;
}
