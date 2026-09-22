// The slice of the OpenCode v2 client this plugin uses. v2 hands a TUI plugin a full client,
// but the plugin only ever needs these calls, so this is the whole compatibility boundary:
// nothing else in the v2 adapter names a v2 method, and every response is validated (as
// `unknown`) before use rather than trusted to match generated types. Remote clients never
// choose a method or a route; these are fixed call sites.
export interface V2RequestOptions { readonly signal: AbortSignal }

export interface V2Client {
  session: {
    list(input: { directory: string; parentID: null; limit: number; cursor?: string }, options: V2RequestOptions): Promise<unknown>
    create(input: { location: { directory: string } }, options: V2RequestOptions): Promise<unknown>
    get(input: { sessionID: string }, options: V2RequestOptions): Promise<unknown>
    prompt(input: { sessionID: string; text: string }, options: V2RequestOptions): Promise<unknown>
    interrupt(input: { sessionID: string }, options: V2RequestOptions): Promise<unknown>
    active(options: V2RequestOptions): Promise<unknown>
    form: {
      list(input: { sessionID: string }, options: V2RequestOptions): Promise<unknown>
      reply(input: { sessionID: string; formID: string; answer: Record<string, string | readonly string[]> },
        options: V2RequestOptions): Promise<unknown>
      cancel(input: { sessionID: string; formID: string }, options: V2RequestOptions): Promise<unknown>
    }
  }
  message: {
    list(input: { sessionID: string; limit: number; order?: "asc" | "desc"; cursor?: string }, options: V2RequestOptions): Promise<unknown>
  }
  permission: {
    list(input: { sessionID: string }, options: V2RequestOptions): Promise<unknown>
    reply(input: { sessionID: string; requestID: string; decision: "once" | "always" | "reject" },
      options: V2RequestOptions): Promise<unknown>
  }
  event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<unknown>
  }
  location: {
    get(input: { location: { directory: string } }, options: V2RequestOptions): Promise<unknown>
  }
  model: {
    list(input: { location: { directory: string } }, options: V2RequestOptions): Promise<unknown>
  }
  provider: {
    get(input: { providerID: string; location: { directory: string } }, options: V2RequestOptions): Promise<unknown>
  }
}
