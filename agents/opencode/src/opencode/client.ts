// The slice of the OpenCode client this plugin uses. OpenCode hands a TUI plugin a full client,
// but the plugin only ever needs these calls, so this is the whole compatibility boundary:
// nothing else in the adapter names an OpenCode method, and every response is validated (as
// `unknown`) before use rather than trusted to match generated types. Remote clients never
// choose a method or a route; these are fixed call sites.
export interface RequestOptions { readonly signal: AbortSignal }

export interface OpenCodeClient {
  session: {
    list(input: { directory?: string; parentID: string | null; limit: number; cursor?: string }, options: RequestOptions): Promise<unknown>
    create(input: { location: { directory: string } }, options: RequestOptions): Promise<unknown>
    get(input: { sessionID: string }, options: RequestOptions): Promise<unknown>
    fork(input: { sessionID: string }, options: RequestOptions): Promise<unknown>
    remove(input: { sessionID: string }, options: RequestOptions): Promise<unknown>
    prompt(input: { sessionID: string; text: string }, options: RequestOptions): Promise<unknown>
    interrupt(input: { sessionID: string }, options: RequestOptions): Promise<unknown>
    switchAgent(input: { sessionID: string; agent: "build" | "plan" }, options: RequestOptions): Promise<unknown>
    switchModel(input: { sessionID: string; model: { id: string; providerID: string; variant?: string } },
      options: RequestOptions): Promise<unknown>
    active(options: RequestOptions): Promise<unknown>
    form: {
      list(input: { sessionID: string }, options: RequestOptions): Promise<unknown>
      reply(input: { sessionID: string; formID: string; answer: Record<string, string | readonly string[]> },
        options: RequestOptions): Promise<unknown>
      cancel(input: { sessionID: string; formID: string }, options: RequestOptions): Promise<unknown>
    }
  }
  message: {
    list(input: { sessionID: string; limit: number; order?: "asc" | "desc"; cursor?: string }, options: RequestOptions): Promise<unknown>
  }
  permission: {
    list(input: { sessionID: string }, options: RequestOptions): Promise<unknown>
    reply(input: { sessionID: string; requestID: string; decision: "once" | "always" | "reject" },
      options: RequestOptions): Promise<unknown>
  }
  event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown>
  }
  location: {
    get(input: { location: { directory: string } }, options: RequestOptions): Promise<unknown>
  }
  model: {
    list(input: { location: { directory: string } }, options: RequestOptions): Promise<unknown>
  }
  mcp: {
    list(input: { location: { directory: string } }, options: RequestOptions): Promise<unknown>
  }
  provider: {
    get(input: { providerID: string; location: { directory: string } }, options: RequestOptions): Promise<unknown>
  }
}
