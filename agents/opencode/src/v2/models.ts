import { z } from "zod";
import { modelSummarySchema } from "@openremotecode/protocol";
import type { V2Client, V2RequestOptions } from "./client.js";

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

/// Selectable models for chat.models. v2 has no single call that nests models under their
/// provider (unlike v1's config.providers()): model.list() returns every model actually usable
/// -- including the "opencode" zen catalog, which needs no configured credentials and would not
/// appear in provider.list() -- so it is the source of truth here, enriched with each distinct
/// provider's display name from provider.get(). A provider that fails to resolve falls back to
/// showing its bare id rather than dropping its models; this is display-only, and prompting still
/// goes through OpenCode's own validation regardless of what name is shown.
export async function buildV2Models(client: V2Client, directory: string, signal: AbortSignal): Promise<unknown> {
  const options = (): V2RequestOptions => ({ signal });
  // model.list() scoped to a directory answers empty until that location has been resolved at
  // least once (confirmed against a real server: neither session.list nor omitting location does
  // this -- only location.get does).
  await client.location.get({ location: { directory } }, options());
  const models = modelList.parse(await client.model.list({ location: { directory } }, options())).data;
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
