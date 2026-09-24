import { z } from "zod";
import { modelSummarySchema } from "@openremotecode/protocol";
import type { OpenCodeClient, RequestOptions } from "./client.js";

const MAX_MODELS = 200;
const MAX_PROVIDERS = 20;
const MAX_EFFORT_LEVELS = 10;
const id = z.string().min(1).max(128);

const model = z.object({
  id, modelID: z.string().min(1), providerID: id, name: z.string().min(1).max(256),
  variants: z.array(z.object({ id: z.string() }).loose()).max(64).optional(),
}).loose();
// Bounded generously against a corrupted local response; the exposed list is separately
// capped at MAX_MODELS below.
const modelList = z.object({ data: z.array(model).max(2_000) });
const provider = z.object({ id, name: z.string().min(1).max(256) }).loose();

function effortLevels(variants: readonly { id: string }[] | undefined): string[] {
  if (!variants) return [];
  const ids = variants.map((v) => v.id).filter((v) => v.length > 0 && v.length <= 128);
  return [...new Set(ids)].slice(0, MAX_EFFORT_LEVELS);
}

/// Every model usable in `directory`. model.list() scoped to a directory answers empty until that
/// location has been resolved at least once (confirmed against a real server: neither
/// session.list nor omitting location does this -- only location.get does).
async function listModels(client: OpenCodeClient, directory: string, signal: AbortSignal): Promise<z.infer<typeof model>[]> {
  const options = (): RequestOptions => ({ signal });
  await client.location.get({ location: { directory } }, options());
  return modelList.parse(await client.model.list({ location: { directory } }, options())).data;
}

/// The effort levels a model currently reports, or undefined when `directory` has no such model.
/// chat.prompt re-validates against this before switching, never trusting a client-asserted
/// model or effort id -- even though the mobile client only offers ids chat.models gave it.
export async function modelEffortLevels(client: OpenCodeClient, directory: string, providerID: string,
    modelID: string, signal: AbortSignal): Promise<string[] | undefined> {
  const found = (await listModels(client, directory, signal)).find((m) => m.providerID === providerID && m.id === modelID);
  return found ? effortLevels(found.variants) : undefined;
}

/// Selectable models for chat.models. OpenCode has no single call that nests models under their
/// provider: model.list() returns every model actually usable
/// -- including the "opencode" zen catalog, which needs no configured credentials and would not
/// appear in provider.list() -- so it is the source of truth here, enriched with each distinct
/// provider's display name from provider.get(). A provider that fails to resolve falls back to
/// showing its bare id rather than dropping its models; this is display-only, and prompting still
/// goes through OpenCode's own validation regardless of what name is shown.
export async function buildModels(client: OpenCodeClient, directory: string, signal: AbortSignal): Promise<unknown> {
  const options = (): RequestOptions => ({ signal });
  const models = await listModels(client, directory, signal);
  const providerIds = [...new Set(models.map((m) => m.providerID))].slice(0, MAX_PROVIDERS);
  const names = new Map<string, string>();
  await Promise.all(providerIds.map(async (providerID) => {
    try {
      names.set(providerID, provider.parse(await client.provider.get({ providerID, location: { directory } }, options())).name);
    } catch {
      // A provider that cannot be resolved is shown by its own id rather than dropping its models.
    }
  }));
  return {
    version: 1,
    models: models.slice(0, MAX_MODELS).map((m) => {
      const levels = effortLevels(m.variants);
      return modelSummarySchema.parse({
        providerID: m.providerID, providerName: names.get(m.providerID) ?? m.providerID,
        modelID: m.id, modelName: m.name, ...(levels.length > 0 ? { effortLevels: levels } : {}),
      });
    }),
  };
}
