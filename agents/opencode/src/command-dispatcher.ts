import { createHash } from "node:crypto"
import {
  decryptRelayEnvelope,
  chatRequests, chatResponses, CHAT_CAPABILITIES, type ChatOperation,
  projectMcpRequests, projectMcpResponses, PROJECT_MCP_CAPABILITIES,
  projectMcpUpdatedEventSchema, type ProjectMcpOperation,
  chatStreamRequests, CHAT_STREAM_CAPABILITIES,
  encryptRelayPayload,
  protocolErrorBodySchema,
  relayPayloadSchema,
  RELAY_PROTOCOL_VERSION,
  SESSION_LIST_OPERATION,
  sessionListRequestBodySchema,
  sessionListResponseBodySchema,
  type ConnectorIdentity,
  type ConnectorPublicIdentity,
  type EncryptedRelayEnvelope,
  type ProtocolErrorBody,
  type RelayPayload,
} from "@openremotecode/protocol"

import { ChatAccessError, type ChatAdapter } from "./chat-adapter.js"
import { ProjectMcpSubscriptions, readProjectMcp, type ProjectMcpReader } from "./project-mcp.js"
import { ChatStreams, type ChatStreamReader } from "./chat-stream.js"

import type { SessionReader } from "./opencode-adapter.js"

interface CommandDispatcherOptions {
  connectorIdentity: ConnectorIdentity
  trustedClient: ConnectorPublicIdentity
  sessions: SessionReader
  chats?: ChatAdapter
  mcp?: ProjectMcpReader
  stream?: ChatStreamReader
  now?: () => number
}

const mutations = new Set<ChatOperation>(["chat.create", "chat.prompt", "chat.abort", "chat.delete", "chat.rename", "chat.fork"])
interface RelayBinding { controller: AbortController; subscriptions?: ProjectMcpSubscriptions; chats?: ChatStreams }

export class CommandDispatcher {
  readonly #connectorIdentity: ConnectorIdentity
  readonly #trustedClient: ConnectorPublicIdentity
  readonly #sessions: SessionReader
  readonly #now: () => number
  #outgoingSequence = 0
  readonly #chats: ChatAdapter | undefined
  readonly #mcp: ProjectMcpReader | undefined
  readonly #stream: ChatStreamReader | undefined
  #relay: RelayBinding | undefined
  #incoming = 0
  readonly #frames = new Map<string, number>()
  readonly #requests = new Map<string, { signature: string; expires: number; response: Promise<EncryptedRelayEnvelope | undefined> }>()

  get capabilities(): string[] { return [SESSION_LIST_OPERATION, ...(this.#chats ? CHAT_CAPABILITIES : []),
    ...(this.#mcp ? PROJECT_MCP_CAPABILITIES : []), ...(this.#stream ? CHAT_STREAM_CAPABILITIES : [])] }

  constructor(options: CommandDispatcherOptions) {
    this.#connectorIdentity = options.connectorIdentity
    this.#trustedClient = options.trustedClient
    this.#sessions = options.sessions
    this.#chats = options.chats
    this.#mcp = options.mcp
    this.#stream = options.stream
    this.#now = options.now ?? Date.now
  }

  attachRelay(send: (envelope: EncryptedRelayEnvelope) => boolean): () => void {
    this.dispose()
    const controller = new AbortController()
    const subscriptions = this.#mcp ? new ProjectMcpSubscriptions(this.#mcp, async (update, signal) => {
      if (controller.signal.aborted || signal.aborted) return false
      const payload = projectMcpUpdatedEventSchema.parse({ protocolVersion: RELAY_PROTOCOL_VERSION,
        kind: "event", operation: "project.mcp.updated", requestId: update.subscriptionId,
        sentAt: this.#now(), body: update })
      const envelope = await this.#encryptResponse(payload, payload.operation, payload.body, "event")
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- either signal can abort during the preceding await
      if (controller.signal.aborted || signal.aborted) return false
      return send(envelope)
    }, this.#now) : undefined
    const chats = this.#stream ? new ChatStreams(this.#stream, async (update, signal) => {
      if (controller.signal.aborted || signal.aborted) return false
      const request = relayPayloadSchema.parse({ protocolVersion: 1, kind: "event", operation: "chat.stream.updated",
        requestId: update.subscriptionId, sentAt: this.#now(), body: JSON.parse(JSON.stringify(update)) as unknown })
      const envelope = await this.#encryptResponse(request, request.operation, update, "event")
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- either signal can abort during the preceding await
      return !controller.signal.aborted && !signal.aborted && send(envelope)
    }, async (target) => {
      if (controller.signal.aborted) return
      const { version, projectId, sessionId, subscriptionId, parentSessionId } = target
      const body = { version, projectId, sessionId, subscriptionId, ...(parentSessionId ? { parentSessionId } : {}) }
      const request = relayPayloadSchema.parse({ protocolVersion: 1, kind: "event", operation: "chat.stream.closed",
        requestId: subscriptionId, sentAt: this.#now(), body })
      const envelope = await this.#encryptResponse(request, request.operation, body, "event")
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the signal can abort during the preceding await
      if (!controller.signal.aborted) send(envelope)
    }) : undefined
    const binding: RelayBinding = { controller, ...(subscriptions ? { subscriptions } : {}), ...(chats ? { chats } : {}) }
    this.#relay = binding
    return () => { if (this.#relay === binding) this.dispose() }
  }

  dispose(): void {
    this.#relay?.controller.abort()
    this.#relay?.subscriptions?.dispose()
    this.#relay?.chats?.dispose()
    this.#relay = undefined
  }

  async handle(envelope: unknown): Promise<EncryptedRelayEnvelope | undefined> {
    if (this.#incoming >= 8) return undefined
    this.#incoming++
    const relay = this.#relay
    try {
      const response = await this.#dispatch(envelope, relay)
      return this.#relay === relay && !relay?.controller.signal.aborted ? response : undefined
    } finally { this.#incoming-- }
  }

  async #dispatch(frame: unknown, relay: RelayBinding | undefined): Promise<EncryptedRelayEnvelope | undefined> {
    let request: RelayPayload
    try {
      request = await decryptRelayEnvelope({
        recipient: this.#connectorIdentity,
        sender: this.#trustedClient,
        envelope: frame,
        now: this.#now(),
      })
    } catch {
      return undefined
    }
    if (this.#relay !== relay || relay?.controller.signal.aborted) return undefined

    const now = this.#now()
    for (const [id, expires] of this.#frames) if (expires <= now) this.#frames.delete(id)
    for (const [id, entry] of this.#requests) if (entry.expires <= now) this.#requests.delete(id)
    const envelope = frame as EncryptedRelayEnvelope
    if (this.#frames.has(envelope.messageId) || this.#frames.size >= 2048) return undefined
    this.#frames.set(envelope.messageId, envelope.expiresAt)
    if (!mutations.has(request.operation as ChatOperation)) return this.#execute(request, relay)
    const signature = createHash("sha256").update(JSON.stringify([request.operation, request.body])).digest("hex")
    const previous = this.#requests.get(request.requestId)
    if (previous) return previous.signature === signature ? previous.response : undefined
    if (this.#requests.size >= 128) return undefined
    const response = this.#execute(request, relay)
    this.#requests.set(request.requestId, { signature, expires: now + 300000, response })
    return response
  }

  async #execute(request: RelayPayload, relay: RelayBinding | undefined): Promise<EncryptedRelayEnvelope> {
    if (request.kind !== "request") {
      return this.#errorResponse(request, {
        code: "invalid_request",
        message: "Only request payloads can be dispatched",
      })
    }

    if (this.#stream && Object.hasOwn(chatStreamRequests, request.operation)) {
      const operation = request.operation as keyof typeof chatStreamRequests
      const body = chatStreamRequests[operation].safeParse(request.body)
      if (!body.success) return this.#errorResponse(request, { code: "invalid_request", message: "The request body is invalid" })
      try {
        if (!relay?.chats) throw new ChatAccessError("context_expired")
        const result = operation === "chat.stream.subscribe" ? await relay.chats.subscribe(body.data)
          : relay.chats.unsubscribe(body.data)
        return await this.#encryptResponse(request, operation, result)
      } catch (error) {
        return this.#errorResponse(request, { code: error instanceof ChatAccessError ? error.code : "opencode_error",
          message: "The agent could not complete the request" })
      }
    }

    if (this.#mcp && Object.hasOwn(projectMcpRequests, request.operation)) {
      const operation = request.operation as ProjectMcpOperation
      const body = projectMcpRequests[operation].safeParse(request.body)
      if (!body.success) return this.#errorResponse(request, { code: "invalid_request", message: "The request body is invalid" })
      try {
        let result: unknown
        if (operation === "project.mcp.snapshot") {
          result = await readProjectMcp(this.#mcp, body.data.projectId, relay?.controller.signal ?? new AbortController().signal)
        } else {
          if (!relay?.subscriptions || !("subscriptionId" in body.data) || typeof body.data.subscriptionId !== "string") {
            throw new ChatAccessError("context_expired")
          }
          result = operation === "project.mcp.subscribe"
            ? await relay.subscriptions.subscribe(body.data.projectId, body.data.subscriptionId)
            : relay.subscriptions.unsubscribe(body.data.projectId, body.data.subscriptionId)
        }
        return await this.#encryptResponse(request, operation, projectMcpResponses[operation].parse(result))
      } catch (error) {
        return this.#errorResponse(request, { code: error instanceof ChatAccessError ? error.code : "opencode_error",
          message: "OpenCode could not complete the request" })
      }
    }

    if (this.#chats && Object.hasOwn(chatRequests, request.operation)) {
      const operation = request.operation as ChatOperation
      const body = chatRequests[operation].safeParse(request.body)
      if (!body.success) return this.#errorResponse(request, { code: "invalid_request", message: "The request body is invalid" })
      try {
        const result = chatResponses[operation].parse(await this.#chats.execute(operation, body.data))
        return await this.#encryptResponse(request, operation, result)
      } catch (error) {
        const code = error instanceof ChatAccessError ? error.code :
          mutations.has(operation) ? "uncertain_outcome" : "opencode_error"
        return this.#errorResponse(request, { code, message: "OpenCode could not complete the request" })
      }
    }

    if (request.operation !== SESSION_LIST_OPERATION) {
      return this.#errorResponse(request, {
        code: "unsupported_operation",
        message: "The requested operation is not supported",
      })
    }

    const body = sessionListRequestBodySchema.safeParse(request.body)
    if (!body.success) {
      return this.#errorResponse(request, {
        code: "invalid_request",
        message: "The request body is invalid",
      })
    }

    try {
      const sessions = await this.#sessions.listSessions()
      return await this.#encryptResponse(request, SESSION_LIST_OPERATION, {
        sessions,
      })
    } catch {
      return this.#errorResponse(request, {
        code: "opencode_error",
        message: "OpenCode could not list sessions",
      })
    }
  }

  async #errorResponse(
    request: RelayPayload,
    body: ProtocolErrorBody,
  ): Promise<EncryptedRelayEnvelope> {
    return this.#encryptResponse(
      request,
      "protocol.error",
      protocolErrorBodySchema.parse(body),
    )
  }

  async #encryptResponse(
    request: RelayPayload,
    operation: string,
    body: unknown,
    kind: "response" | "event" = "response",
  ): Promise<EncryptedRelayEnvelope> {
    const payload = relayPayloadSchema.parse({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind,
      requestId: request.requestId,
      sentAt: this.#now(),
      operation,
      body:
        operation === SESSION_LIST_OPERATION
          ? sessionListResponseBodySchema.parse(body)
          : operation === "protocol.error" ? protocolErrorBodySchema.parse(body) : body,
    })
    const sequence = this.#outgoingSequence
    this.#outgoingSequence += 1

    return encryptRelayPayload({
      sender: this.#connectorIdentity,
      recipient: this.#trustedClient,
      payload,
      sequence,
      now: this.#now(),
    })
  }
}
