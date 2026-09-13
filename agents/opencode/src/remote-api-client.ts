import {
  pairingTranscriptSchema,
  type ConnectorPublicIdentity,
  type IdentityProof,
  type PairingTranscript,
} from "@openremotecode/protocol"
import { validateServiceOrigin } from "./service-origin.js"

export interface PairingStart {
  pairingId: string
  pairingSecret: string
  userCode: string
  serviceId: string
  verificationUri: string
  expiresAt: string
  pollIntervalSeconds: number
}

export interface PairingPoll {
  status: "pending" | "verification" | "confirmed" | "completed" | "expired"
  pairingId: string
  serviceId: string
  expiresAt: string
  transcript?: PairingTranscript
  connectorId?: string
  connectorCredential?: string
  connectorCredentialExpiresAt?: string
  linkedAt?: string
}

export interface RelayAdmission {
  url: URL
  protocols: string[]
  expiresAt: number
}

export class RemoteAPIClient {
  readonly #serviceOrigin: string

  constructor(
    serviceOrigin: URL,
    private readonly request: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.#serviceOrigin = validateServiceOrigin(serviceOrigin.href).origin
  }

  get serviceOrigin(): URL { return new URL(this.#serviceOrigin) }

  async startPairing(input: {
    name: string
    identity: ConnectorPublicIdentity
    proof: IdentityProof
  }): Promise<PairingStart> {
    const response = await this.#request("/v1/connector-pairings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    return parsePairingStart(response)
  }

  async connectorChallenge(): Promise<{ challenge: string; expiresAt: string }> {
    return parseChallenge(await this.#request("/v1/connector-pairings/challenge", { method: "POST" }))
  }

  async pollPairing(pairingId: string, pairingSecret: string): Promise<PairingPoll> {
    return parsePairingPoll(await this.#request(
      `/v1/connector-pairings/${encodeURIComponent(pairingId)}/poll`,
      { method: "POST", headers: { Authorization: `Pairing ${pairingSecret}` } },
    ))
  }

  async cancelPairing(pairingId: string, pairingSecret: string): Promise<void> {
    await this.#request(
      `/v1/connector-pairings/${encodeURIComponent(pairingId)}/cancel`,
      { method: "POST", headers: { Authorization: `Pairing ${pairingSecret}` } },
    )
  }

  async ownConnector(connectorCredential: string, signal?: AbortSignal): Promise<{ connectorId: string; linkedAt: string }> {
    const record = objectRecord(await this.#request("/v1/connectors/self", {
      method: "GET",
      headers: { Authorization: `Bearer ${connectorCredential}` },
      ...(signal ? { signal } : {}),
    }))
    return { connectorId: requiredString(record, "connectorId"), linkedAt: requiredDate(record, "linkedAt") }
  }

  async revokeConnector(connectorCredential: string, signal?: AbortSignal): Promise<void> {
    await this.#request("/v1/connectors/self/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${connectorCredential}` },
      ...(signal ? { signal } : {}),
    })
  }

  async relayAdmission(connectorCredential: string, signal?: AbortSignal): Promise<RelayAdmission> {
    const document = await this.#request("/v1/relay/tickets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connectorCredential}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      ...(signal ? { signal } : {}),
    })
    const record = objectRecord(document)
    const ticket = requiredString(record, "ticket")
    const expiresAt = requiredDate(record, "expiresAt")
    const webSocketPath = requiredString(record, "webSocketUrl")
    let url: URL
    try { url = new URL(webSocketPath, this.#serviceOrigin) } catch {
      throw new Error("Remote service returned an invalid WebSocket URL")
    }
    // The v1 contract returns this exact path. Also check the parsed URL so
    // URL normalization cannot turn an apparent path into another origin.
    if (webSocketPath !== "/v1/relay" || url.origin !== this.#serviceOrigin ||
      url.pathname !== "/v1/relay" || url.username || url.password || /[?#]/u.test(url.href)) {
      throw new Error("Remote service returned an invalid WebSocket URL")
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    return {
      url,
      protocols: ["opencode-remote.v1", `ticket.${ticket}`],
      expiresAt: Date.parse(expiresAt),
    }
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    const origin = validateServiceOrigin(this.#serviceOrigin)
    const response = await this.request(new URL(path, origin), {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    })
    let document: unknown
    try { document = await response.json() } catch { document = undefined }
    if (!response.ok) {
      const record = document && typeof document === "object" ? document as Record<string, unknown> : undefined
      const message = record && typeof record.message === "string" ? record.message : "Remote service request failed"
      throw new Error(message)
    }
    return document
  }
}

function parseChallenge(value: unknown) {
  const record = objectRecord(value)
  const challenge = requiredString(record, "challenge")
  if (!/^[A-Za-z0-9_-]{43}$/u.test(challenge)) throw new Error("Remote service returned an invalid challenge")
  return { challenge, expiresAt: requiredDate(record, "expiresAt") }
}

function parsePairingStart(value: unknown): PairingStart {
  const record = objectRecord(value)
  const pollIntervalSeconds = record.pollIntervalSeconds
  if (typeof pollIntervalSeconds !== "number" || !Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 1 || pollIntervalSeconds > 30) {
    throw new Error("Remote service returned an invalid poll interval")
  }
  return {
    pairingId: requiredString(record, "pairingId"),
    pairingSecret: requiredToken(record, "pairingSecret", "orp_"),
    userCode: requiredString(record, "userCode"),
    serviceId: requiredString(record, "serviceId"),
    verificationUri: requiredString(record, "verificationUri"),
    expiresAt: requiredDate(record, "expiresAt"),
    pollIntervalSeconds,
  }
}

function parsePairingPoll(value: unknown): PairingPoll {
  const record = objectRecord(value)
  const status = requiredString(record, "status")
  if (!["pending", "verification", "confirmed", "completed", "expired"].includes(status)) {
    throw new Error("Remote service returned an invalid pairing state")
  }
  const result: PairingPoll = {
    status: status as PairingPoll["status"],
    pairingId: requiredString(record, "pairingId"),
    serviceId: requiredString(record, "serviceId"),
    expiresAt: requiredDate(record, "expiresAt"),
  }
  if (record.transcript !== undefined) result.transcript = pairingTranscriptSchema.parse(record.transcript)
  if (record.connectorId !== undefined) result.connectorId = requiredString(record, "connectorId")
  if (record.connectorCredential !== undefined) result.connectorCredential = requiredToken(record, "connectorCredential", "orc_")
  if (record.connectorCredentialExpiresAt !== undefined) result.connectorCredentialExpiresAt = requiredDate(record, "connectorCredentialExpiresAt")
  if (record.linkedAt !== undefined) result.linkedAt = requiredDate(record, "linkedAt")
  return result
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Remote service returned an invalid response")
  return value as Record<string, unknown>
}
function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value === "") throw new Error("Remote service returned an invalid response")
  return value
}
function requiredDate(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key)
  if (Number.isNaN(Date.parse(value))) throw new Error("Remote service returned an invalid response")
  return value
}
function requiredToken(record: Record<string, unknown>, key: string, prefix: string): string {
  const value = requiredString(record, key)
  if (!new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`, "u").test(value)) throw new Error("Remote service returned an invalid credential")
  return value
}
