import {
  clientHelloSchema,
  clientOfflineSchema,
  relayReadySchema,
  type ConnectorHello,
} from "@openremotecode/protocol"

import type { RelayAdmission } from "./remote-api-client.js"
import { validateLocalRelayURL, validateRelayURL } from "./service-origin.js"

export type RelayLogLevel = "debug" | "info" | "warn" | "error"
export type RelayLogger = (
  level: RelayLogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

interface RelayConnectionOptions {
  url?: URL
  admissionProvider?: (signal: AbortSignal) => Promise<RelayAdmission>
  hello: ConnectorHello
  log: RelayLogger
  handleMessage?: (message: unknown) => Promise<unknown>
  onReady?: (send: (message: unknown) => boolean) => (() => void)
  onPresence?: (clientConnected: boolean) => void
}

const INITIAL_RECONNECT_DELAY_MS = 250
const MAX_RECONNECT_DELAY_MS = 10_000
const MAX_RELAY_FRAME_LENGTH = 2_000_000

export class RelayConnection {
  readonly #url: URL | undefined
  readonly #admissionProvider: ((signal: AbortSignal) => Promise<RelayAdmission>) | undefined
  readonly #hello: ConnectorHello
  readonly #log: RelayLogger
  readonly #handleMessage: ((message: unknown) => Promise<unknown>) | undefined
  readonly #onReady: RelayConnectionOptions["onReady"]
  readonly #onPresence: RelayConnectionOptions["onPresence"]
  #disconnect: (() => void) | undefined
  #socket: WebSocket | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #reconnectAttempts = 0
  #stopped = false
  #admitted = false
  #attemptController: AbortController | undefined

  constructor(options: RelayConnectionOptions) {
    this.#url = options.url ? validateLocalRelayURL(options.url.href) : undefined
    this.#admissionProvider = options.admissionProvider
    if ((!this.#url && !this.#admissionProvider) || (this.#url && this.#admissionProvider)) {
      throw new Error("Relay connection requires exactly one admission source")
    }
    this.#hello = options.hello
    this.#log = options.log
    this.#handleMessage = options.handleMessage
    this.#onReady = options.onReady
    this.#onPresence = options.onPresence
  }

  start(): void {
    if (this.#stopped || this.#socket || this.#attemptController) return
    void this.#connect()
  }

  async stop(): Promise<void> {
    this.#stopped = true
    this.#attemptController?.abort(new Error("Plugin disposed"))
    this.#attemptController = undefined
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
    const socket = this.#socket
    this.#invalidate()
    this.#socket = undefined
    if (!socket || socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000)
      socket.addEventListener("close", () => { clearTimeout(timeout); resolve() }, { once: true })
      socket.close(1000, "Plugin disposed")
    })
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return
    const controller = new AbortController()
    this.#attemptController = controller

    let admission: RelayAdmission | undefined
    try {
      admission = this.#admissionProvider
        ? await this.#admissionProvider(controller.signal)
        : undefined
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop()/a new attempt can change these during the preceding await
      if (this.#stopped || controller.signal.aborted || this.#attemptController !== controller) return
      this.#attemptController = undefined
      await this.#safeLog("warn", "Relay admission unavailable", { error: errorMessage(error) })
      this.#scheduleReconnect()
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop()/a new attempt can change these during the preceding await
    if (this.#stopped || controller.signal.aborted || this.#attemptController !== controller) return

    let socket: WebSocket
    try {
      // The constructor enforces exactly one of url/admissionProvider, so no
      // admission here (falsy) means #url must be set.
      socket = admission
        ? new WebSocket(validateRelayURL(admission.url.href), admission.protocols)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        : new WebSocket(validateLocalRelayURL(this.#url!.href))
    } catch (error) {
      this.#attemptController = undefined
      await this.#safeLog("error", "Failed to create relay connection", { error: errorMessage(error) })
      this.#scheduleReconnect()
      return
    }

    this.#socket = socket
    socket.addEventListener("open", () => void this.#handleOpen(socket))
    socket.addEventListener("message", (event) => { void this.#handleIncomingMessage(socket, event.data) })
    socket.addEventListener("error", () => { void this.#safeLog("warn", "Relay connection error") })
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return
      this.#invalidate()
      this.#socket = undefined
      if (this.#attemptController === controller) this.#attemptController = undefined
      if (this.#stopped) return
      void this.#safeLog("warn", "Relay connection closed; reconnecting")
      this.#scheduleReconnect()
    })
  }

  async #handleOpen(socket: WebSocket): Promise<void> {
    if (this.#stopped || this.#socket !== socket) return
    try {
      socket.send(JSON.stringify(this.#hello))
      if (!this.#admissionProvider) {
        this.#admit(socket)
        await this.#safeLog("info", "Connected to local relay integration endpoint")
      }
    } catch (error) {
      await this.#safeLog("error", "Failed to initialize relay connection", { error: errorMessage(error) })
      socket.close(1011, "Initialization failed")
    }
  }

  async #handleIncomingMessage(socket: WebSocket, data: unknown): Promise<void> {
    if (this.#stopped || this.#socket !== socket || typeof data !== "string") return
    if (data.length > MAX_RELAY_FRAME_LENGTH) {
      socket.close(1009, "Relay frame is too large")
      return
    }
    let message: unknown
    try { message = JSON.parse(data) } catch {
      await this.#safeLog("warn", "Rejected malformed relay frame")
      return
    }

    if (this.#admissionProvider && !this.#admitted) {
      const ready = relayReadySchema.safeParse(message)
      if (!ready.success || ready.data.role !== "connector" || ready.data.keyId !== this.#hello.identity.keyId) {
        socket.close(1008, "Relay admission mismatch")
        return
      }
      this.#admit(socket)
      await this.#safeLog("info", "Connected to authenticated remote relay")
      return
    }
    if (!this.#admitted) return

    const clientOnline = clientHelloSchema.safeParse(message)
    if (clientOnline.success) {
      this.#onPresence?.(true)
      return
    }
    const clientOffline = clientOfflineSchema.safeParse(message)
    if (clientOffline.success) {
      this.#onPresence?.(false)
      return
    }

    if (!this.#handleMessage) return
    try {
      const response = await this.#handleMessage(message)
      if (response !== undefined) this.#send(socket, response)
    } catch {
      await this.#safeLog("error", "Relay message handling failed")
    }
  }

  #admit(socket: WebSocket): void {
    this.#admitted = true
    this.#reconnectAttempts = 0
    this.#disconnect = this.#onReady?.((message) => this.#send(socket, message))
  }

  #invalidate(): void {
    const wasAdmitted = this.#admitted
    this.#admitted = false
    const disconnect = this.#disconnect
    this.#disconnect = undefined
    disconnect?.()
    if (wasAdmitted) this.#onPresence?.(false)
  }

  #send(socket: WebSocket, message: unknown): boolean {
    if (this.#stopped || !this.#admitted || this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      const frame = JSON.stringify(message)
      if (Buffer.byteLength(frame) + socket.bufferedAmount > MAX_RELAY_FRAME_LENGTH) {
        this.#invalidate()
        socket.close(1013, "Relay backpressure")
        return false
      }
      socket.send(frame)
      return true
    } catch {
      this.#invalidate()
      socket.close(1011, "Relay send failed")
      return false
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return
    const baseDelay = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** this.#reconnectAttempts, MAX_RECONNECT_DELAY_MS)
    const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5))
    this.#reconnectAttempts += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      void this.#connect()
    }, delay)
  }

  async #safeLog(level: RelayLogLevel, message: string, extra?: Record<string, unknown>): Promise<void> {
    try { await this.#log(level, message, extra) } catch { /* Logging cannot interrupt OpenCode. */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
