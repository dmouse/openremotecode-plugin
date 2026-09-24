import type { OpenCodeClient } from "./client.js";

export interface OpenCodeEvent { readonly type: string; readonly data?: Record<string, unknown> }

/// Wraps the client's own event subscription, a typed async iterable, so a failure surfaces as
/// one fixed error rather than whatever the transport threw.
export async function* openCodeEvents(client: Pick<OpenCodeClient, "event">, signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
  try {
    for await (const event of client.event.subscribe({ signal })) {
      if (signal.aborted) return;
      yield event as OpenCodeEvent;
    }
  } catch (cause) {
    if (!signal.aborted) throw new Error("Agent event stream unavailable", { cause });
  }
}
