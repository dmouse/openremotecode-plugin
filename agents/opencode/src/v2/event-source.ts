import type { V2Client } from "./client.js";

export interface V2Event { readonly type: string; readonly data?: Record<string, unknown> }

/// Wraps the v2 client's own event subscription. Unlike v1 (whose root SDK client cannot reach
/// the embedded server, forcing a raw SSE re-fetch, see opencode-events.ts), the v2 client
/// already exposes a typed async iterable, so no transport shim is needed here.
export async function* v2Events(client: Pick<V2Client, "event">, signal: AbortSignal): AsyncGenerator<V2Event> {
  try {
    for await (const event of client.event.subscribe({ signal })) {
      if (signal.aborted) return;
      yield event as V2Event;
    }
  } catch (cause) {
    if (!signal.aborted) throw new Error("Agent event stream unavailable", { cause });
  }
}
