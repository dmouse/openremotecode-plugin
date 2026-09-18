import {
  clientHelloSchema,
  clientOfflineSchema,
  deriveRelayEpoch,
  generateRelayNonce,
  relayReadySchema,
  type ConnectorHello,
} from "@openremotecode/protocol";

import type { RelayAdmission } from "./remote-api-client.js";
import { validateLocalRelayURL, validateRelayURL } from "./service-origin.js";

export type RelayLogLevel = "debug" | "info" | "warn" | "error"
export type RelayLogger = (
  level: RelayLogLevel,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

interface RelayConnectionOptions {
  url?: URL
  admissionProvider?: (signal: AbortSignal) => Promise<RelayAdmission>
  hello: Omit<ConnectorHello, "nonce">
  log: RelayLogger
  handleMessage?: (message: unknown) => Promise<unknown>
  onReady?: (send: (message: unknown) => boolean) => (() => void)
  onPresence?: (clientConnected: boolean, epoch?: string) => void
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;
// How long before the current lease's hard expiry to start renewing. The relay force-closes
// at expiry (server/internal/relay/production.go), so this must leave enough room for a
// ticket fetch and a full WebSocket handshake to land before that happens.
const RENEWAL_MARGIN_MS = 45_000;
// A lease capped by a near-expiry underlying credential can leave less room than the margin
// above; renewal still fires almost immediately rather than not at all; see ADR 0014.
const MIN_RENEWAL_DELAY_MS = 1_000;
const RENEWAL_RETRY_DELAY_MS = 5_000;
const MAX_RELAY_FRAME_LENGTH = 2_000_000;
// WebSocket.close() only accepts 1000 or 3000-4999 from a client; the RFC 6455 codes for
// policy, size, and internal failure are reserved for the endpoint itself and throw here.
const RELAY_CLOSE_POLICY = 4008;
const RELAY_CLOSE_FRAME_TOO_LARGE = 4009;
const RELAY_CLOSE_INTERNAL = 4011;
const RELAY_CLOSE_BACKPRESSURE = 4013;

export class RelayConnection {
  readonly #url: URL | undefined;
  readonly #admissionProvider: ((signal: AbortSignal) => Promise<RelayAdmission>) | undefined;
  readonly #hello: Omit<ConnectorHello, "nonce">;
  readonly #log: RelayLogger;
  readonly #handleMessage: ((message: unknown) => Promise<unknown>) | undefined;
  readonly #onReady: RelayConnectionOptions["onReady"];
  readonly #onPresence: RelayConnectionOptions["onPresence"];
  #disconnect: (() => void) | undefined;
  #socket: WebSocket | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempts = 0;
  #stopped = false;
  #admitted = false;
  #nonce: string | undefined;
  #attemptController: AbortController | undefined;
  // A proactive renewal ahead of the current lease's hard expiry. Tracked separately from
  // #socket/#attemptController so the current connection stays live and admitted while its
  // replacement is being negotiated -- see #attemptRenewal and #promote, and ADR 0014.
  #renewalTimer: ReturnType<typeof setTimeout> | undefined;
  #renewalController: AbortController | undefined;
  #renewalSocket: WebSocket | undefined;
  #renewalNonce: string | undefined;

  constructor(options: RelayConnectionOptions) {
    this.#url = options.url ? validateLocalRelayURL(options.url.href) : undefined;
    this.#admissionProvider = options.admissionProvider;
    if ((!this.#url && !this.#admissionProvider) || (this.#url && this.#admissionProvider)) {
      throw new Error("Relay connection requires exactly one admission source");
    }
    this.#hello = options.hello;
    this.#log = options.log;
    this.#handleMessage = options.handleMessage;
    this.#onReady = options.onReady;
    this.#onPresence = options.onPresence;
  }

  start(): void {
    if (this.#stopped || this.#socket || this.#attemptController) return;
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#attemptController?.abort(new Error("Plugin disposed"));
    this.#attemptController = undefined;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#renewalTimer) {
      clearTimeout(this.#renewalTimer);
      this.#renewalTimer = undefined;
    }
    this.#renewalController?.abort(new Error("Plugin disposed"));
    this.#renewalController = undefined;
    const renewalSocket = this.#renewalSocket;
    this.#renewalSocket = undefined;
    this.#renewalNonce = undefined;
    if (renewalSocket && renewalSocket.readyState !== WebSocket.CLOSED) {
      renewalSocket.close(1000, "Plugin disposed");
    }
    const socket = this.#socket;
    this.#invalidate();
    this.#socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000);
      socket.addEventListener("close", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.close(1000, "Plugin disposed");
    });
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    const controller = new AbortController();
    this.#attemptController = controller;

    let admission: RelayAdmission | undefined;
    try {
      admission = this.#admissionProvider
        ? await this.#admissionProvider(controller.signal)
        : undefined;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop()/a new attempt can change these during the preceding await
      if (this.#stopped || controller.signal.aborted || this.#attemptController !== controller) return;
      this.#attemptController = undefined;
      await this.#safeLog("warn", "Relay admission unavailable", { error: errorMessage(error) });
      this.#scheduleReconnect();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop()/a new attempt can change these during the preceding await
    if (this.#stopped || controller.signal.aborted || this.#attemptController !== controller) return;

    let socket: WebSocket;
    try {
      // The constructor enforces exactly one of url/admissionProvider, so no
      // admission here (falsy) means #url must be set.
      socket = admission
        ? new WebSocket(validateRelayURL(admission.url.href), admission.protocols)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        : new WebSocket(validateLocalRelayURL(this.#url!.href));
    } catch (error) {
      this.#attemptController = undefined;
      await this.#safeLog("error", "Failed to create relay connection", { error: errorMessage(error) });
      this.#scheduleReconnect();
      return;
    }

    this.#socket = socket;
    socket.addEventListener("open", () => void this.#handleOpen(socket));
    socket.addEventListener("message", (event) => { void this.#handleIncomingMessage(socket, event.data); });
    socket.addEventListener("error", () => { void this.#safeLog("warn", "Relay connection error"); });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#invalidate();
      this.#socket = undefined;
      if (this.#attemptController === controller) this.#attemptController = undefined;
      if (this.#stopped) return;
      void this.#safeLog("warn", "Relay connection closed; reconnecting");
      this.#scheduleReconnect();
    });
  }

  async #handleOpen(socket: WebSocket): Promise<void> {
    if (this.#stopped || this.#socket !== socket) return;
    try {
      // A nonce per connection, so the epoch it derives can never repeat.
      this.#nonce = generateRelayNonce();
      socket.send(JSON.stringify({ ...this.#hello, nonce: this.#nonce }));
      if (!this.#admissionProvider) {
        this.#admit(socket);
        await this.#safeLog("info", "Connected to local relay integration endpoint");
      }
    } catch (error) {
      await this.#safeLog("error", "Failed to initialize relay connection", { error: errorMessage(error) });
      socket.close(RELAY_CLOSE_INTERNAL, "Initialization failed");
    }
  }

  async #handleIncomingMessage(socket: WebSocket, data: unknown): Promise<void> {
    if (this.#stopped || this.#socket !== socket || typeof data !== "string") return;
    if (data.length > MAX_RELAY_FRAME_LENGTH) {
      socket.close(RELAY_CLOSE_FRAME_TOO_LARGE, "Relay frame is too large");
      return;
    }
    let message: unknown;
    try { message = JSON.parse(data); } catch {
      await this.#safeLog("warn", "Rejected malformed relay frame");
      return;
    }

    if (this.#admissionProvider && !this.#admitted) {
      const ready = relayReadySchema.safeParse(message);
      if (!ready.success || ready.data.role !== "connector" || ready.data.keyId !== this.#hello.identity.keyId) {
        socket.close(RELAY_CLOSE_POLICY, "Relay admission mismatch");
        return;
      }
      this.#admit(socket);
      this.#scheduleRenewalFromReady(ready.data.authorizationExpiresAt);
      await this.#safeLog("info", "Connected to authenticated remote relay");
      return;
    }
    if (!this.#admitted) return;

    const clientOnline = clientHelloSchema.safeParse(message);
    if (clientOnline.success) {
      const nonce = this.#nonce;
      if (nonce === undefined) return;
      const epoch = await deriveRelayEpoch({
        connectorKeyId: this.#hello.identity.keyId,
        connectorNonce: nonce,
        clientKeyId: clientOnline.data.identity.keyId,
        clientNonce: clientOnline.data.nonce,
      });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- #invalidate() can clear the nonce during the preceding await
      if (this.#stopped || this.#socket !== socket || this.#nonce !== nonce) return;
      this.#onPresence?.(true, epoch);
      return;
    }
    const clientOffline = clientOfflineSchema.safeParse(message);
    if (clientOffline.success) {
      this.#onPresence?.(false);
      return;
    }

    if (!this.#handleMessage) return;
    try {
      const response = await this.#handleMessage(message);
      if (response !== undefined) this.#send(socket, response);
    } catch {
      await this.#safeLog("error", "Relay message handling failed");
    }
  }

  #admit(socket: WebSocket): void {
    this.#admitted = true;
    this.#reconnectAttempts = 0;
    this.#disconnect = this.#onReady?.((message) => this.#send(socket, message));
  }

  #invalidate(): void {
    const wasAdmitted = this.#admitted;
    this.#admitted = false;
    this.#nonce = undefined;
    const disconnect = this.#disconnect;
    this.#disconnect = undefined;
    disconnect?.();
    if (wasAdmitted) this.#onPresence?.(false);
  }

  #send(socket: WebSocket, message: unknown): boolean {
    if (this.#stopped || !this.#admitted || this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      const frame = JSON.stringify(message);
      if (Buffer.byteLength(frame) + socket.bufferedAmount > MAX_RELAY_FRAME_LENGTH) {
        this.#invalidate();
        socket.close(RELAY_CLOSE_BACKPRESSURE, "Relay backpressure");
        return false;
      }
      socket.send(frame);
      return true;
    } catch {
      this.#invalidate();
      socket.close(RELAY_CLOSE_INTERNAL, "Relay send failed");
      return false;
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const baseDelay = Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** this.#reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5));
    this.#reconnectAttempts += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
  }

  #scheduleRenewalFromReady(authorizationExpiresAt: string | undefined): void {
    if (authorizationExpiresAt === undefined) return;
    const expiresAtMs = Date.parse(authorizationExpiresAt);
    if (!Number.isFinite(expiresAtMs)) return;
    this.#scheduleRenewal(expiresAtMs);
  }

  #scheduleRenewal(expiresAtMs: number): void {
    if (this.#renewalTimer) {
      clearTimeout(this.#renewalTimer);
      this.#renewalTimer = undefined;
    }
    if (this.#stopped || !this.#admissionProvider) return;
    const delay = Math.max(expiresAtMs - Date.now() - RENEWAL_MARGIN_MS, MIN_RENEWAL_DELAY_MS);
    this.#renewalTimer = setTimeout(() => {
      this.#renewalTimer = undefined;
      void this.#attemptRenewal();
    }, delay);
  }

  // Opens a brand-new admitted connection while the current one stays live, then hands off to
  // it -- see #promote. Never touches #socket/#attemptController/#scheduleReconnect: a failed
  // renewal attempt simply leaves the current connection running, which falls back to the
  // ordinary reactive reconnect if it eventually hits its own hard lease expiry. This mirrors
  // #connect()'s admission/socket-creation shape but targets the separate #renewal* fields.
  async #attemptRenewal(): Promise<void> {
    if (this.#stopped || !this.#admissionProvider || this.#renewalSocket || this.#renewalController) return;
    const controller = new AbortController();
    this.#renewalController = controller;

    let admission: RelayAdmission;
    try {
      admission = await this.#admissionProvider(controller.signal);
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop()/a new attempt can change these during the preceding await
      if (this.#stopped || controller.signal.aborted || this.#renewalController !== controller) return;
      this.#renewalController = undefined;
      await this.#safeLog("warn", "Relay admission renewal unavailable; will retry before the current lease expires", { error: errorMessage(error) });
      this.#renewalTimer = setTimeout(() => {
        this.#renewalTimer = undefined;
        void this.#attemptRenewal();
      }, RENEWAL_RETRY_DELAY_MS);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop()/a new attempt can change these during the preceding await
    if (this.#stopped || controller.signal.aborted || this.#renewalController !== controller) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(validateRelayURL(admission.url.href), admission.protocols);
    } catch (error) {
      this.#renewalController = undefined;
      await this.#safeLog("error", "Failed to open relay connection for renewal", { error: errorMessage(error) });
      return;
    }
    this.#renewalSocket = socket;

    socket.addEventListener("open", () => {
      if (this.#renewalSocket !== socket) return;
      try {
        this.#renewalNonce = generateRelayNonce();
        socket.send(JSON.stringify({ ...this.#hello, nonce: this.#renewalNonce }));
      } catch (error) {
        void this.#safeLog("error", "Failed to initialize renewed relay connection", { error: errorMessage(error) });
        socket.close(RELAY_CLOSE_INTERNAL, "Initialization failed");
      }
    });
    socket.addEventListener("error", () => { void this.#safeLog("warn", "Relay renewal connection error"); });
    socket.addEventListener("message", (event) => {
      if (this.#renewalSocket !== socket || typeof event.data !== "string") return;
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { return; }
      const ready = relayReadySchema.safeParse(message);
      if (!ready.success || ready.data.role !== "connector" || ready.data.keyId !== this.#hello.identity.keyId) {
        socket.close(RELAY_CLOSE_POLICY, "Relay admission mismatch");
        return;
      }
      const nonce = this.#renewalNonce;
      if (nonce === undefined) return;
      const expiresAtMs = ready.data.authorizationExpiresAt === undefined ? undefined : Date.parse(ready.data.authorizationExpiresAt);
      this.#promote(socket, nonce, Number.isFinite(expiresAtMs) ? expiresAtMs : undefined);
    });
    socket.addEventListener("close", () => {
      if (this.#renewalSocket !== socket) return;
      this.#renewalSocket = undefined;
      this.#renewalNonce = undefined;
      if (this.#renewalController === controller) this.#renewalController = undefined;
      if (this.#stopped) return;
      void this.#safeLog("warn", "Relay renewal connection closed before completing; the current connection remains live");
    });
  }

  // Hands live traffic off from the current #socket to a newly admitted one that was opened
  // ahead of the current lease's expiry (see #attemptRenewal). Reassigning #socket before
  // closing the old one is what makes the old socket's own close listener a no-op via its
  // `this.#socket !== socket` guard: no spurious reconnect, no #invalidate()/onPresence(false)
  // flicker. The old connection's disconnect callback still runs, and the new one gets a fresh
  // onReady subscription, exactly as an ordinary reconnect already does.
  #promote(newSocket: WebSocket, newNonce: string, authorizationExpiresAtMs: number | undefined): void {
    const oldSocket = this.#socket;
    const oldDisconnect = this.#disconnect;

    newSocket.addEventListener("message", (event) => { void this.#handleIncomingMessage(newSocket, event.data); });
    newSocket.addEventListener("error", () => { void this.#safeLog("warn", "Relay connection error"); });
    newSocket.addEventListener("close", () => {
      if (this.#socket !== newSocket) return;
      this.#invalidate();
      this.#socket = undefined;
      this.#attemptController = undefined;
      if (this.#stopped) return;
      void this.#safeLog("warn", "Relay connection closed; reconnecting");
      this.#scheduleReconnect();
    });

    this.#socket = newSocket;
    this.#nonce = newNonce;
    this.#attemptController = undefined;
    this.#admitted = true;
    this.#reconnectAttempts = 0;
    this.#renewalSocket = undefined;
    this.#renewalController = undefined;
    this.#renewalNonce = undefined;

    oldDisconnect?.();
    this.#disconnect = this.#onReady?.((message) => this.#send(newSocket, message));

    if (authorizationExpiresAtMs !== undefined) this.#scheduleRenewal(authorizationExpiresAtMs);

    if (oldSocket && oldSocket !== newSocket && oldSocket.readyState !== WebSocket.CLOSED) {
      oldSocket.close(1000, "Relay admission renewed");
    }
  }

  async #safeLog(level: RelayLogLevel, message: string, extra?: Record<string, unknown>): Promise<void> {
    try { await this.#log(level, message, extra); } catch { /* Logging cannot interrupt OpenCode. */ }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
