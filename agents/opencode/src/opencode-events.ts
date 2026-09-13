import type { PluginInput } from "@opencode-ai/plugin"

const MAX_EVENT_LENGTH = 1_000_000
// Diagnostic only: never set in production. Surfaces the cause this
// generator otherwise swallows, to debug an intermittent CI-only failure.
const DEBUG_EVENTS = process.env.OPENCODE_REMOTE_DEBUG_EVENTS === "1"

/**
 * Pinned 1.18.30 transport shim. The root SDK's event.subscribe() ignores the
 * injected fetch and calls global fetch, which cannot reach the embedded TUI's
 * in-process server. Use its ordinary GET transport with a fixed /event route,
 * preserving authentication, interceptors, project context and cancellation.
 * No URL or SDK operation is selected by a remote client.
 */
export async function* openCodeEvents(client: PluginInput["client"], directory: string,
  signal: AbortSignal): AsyncGenerator {
  const options = { url: "/event", query: { directory }, signal,
    headers: { Accept: "text/event-stream" }, parseAs: "stream" as const, redirect: "error" as const }
  const result = await client.session.list(options)
  if (!result.response.ok || !result.response.headers.get("content-type")?.startsWith("text/event-stream") ||
      !result.response.body) {
    if (DEBUG_EVENTS) console.error("[opencode-events debug] initial response", result.response.status,
      result.response.headers.get("content-type"))
    throw new Error("Agent event stream unavailable")
  }
  const reader = result.response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  let buffer = ""
  try {
    if (signal.aborted) return
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort during reader.read() across iterations
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (frame.length > MAX_EVENT_LENGTH) throw new Error("Agent event limit")
        const lines = frame.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
        if (!lines.length) continue
        const data = lines.map((line) => line.slice(5).replace(/^ /u, "")).join("\n")
        // Invalid JSON/UTF-8 errors can contain source text: never expose them.
        yield JSON.parse(data) as unknown
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort while the consumer processes the yielded event
        if (signal.aborted) return
      }
      if (buffer.length > MAX_EVENT_LENGTH) throw new Error("Agent event limit")
    }
  } catch (cause) {
    if (DEBUG_EVENTS) console.error("[opencode-events debug] read failed", cause)
    if (!signal.aborted) throw new Error("Agent event stream unavailable", { cause })
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
