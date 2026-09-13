import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import {
  connectorPublicIdentitySchema,
  type ConnectorPublicIdentity,
} from "@openremotecode/protocol"

const AUTHORIZATION_FILENAME = "connector-authorization.json"

export interface ConnectorAuthorization {
  version: 1
  serviceOrigin: string
  connectorId: string
  connectorKeyId: string
  credential: string
  credentialExpiresAt: string
  linkedAt?: string
  trustedClient: ConnectorPublicIdentity
}

export interface ConnectorAuthorizationStore {
  load(): Promise<ConnectorAuthorization | undefined>
  replace(value: ConnectorAuthorization): Promise<void>
  clear(): Promise<void>
}

export class FileConnectorAuthorizationStore implements ConnectorAuthorizationStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<ConnectorAuthorization | undefined> {
    let contents: string
    try {
      contents = await readFile(this.filePath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined
      throw error
    }
    if (process.platform !== "win32") {
      const file = await stat(this.filePath)
      if ((file.mode & 0o077) !== 0) {
        throw new Error("Connector authorization file permissions must be 0600")
      }
    }
    let parsed: unknown
    try { parsed = JSON.parse(contents) } catch {
      throw new Error("Connector authorization file is not valid JSON")
    }
    return parseAuthorization(parsed)
  }

  async replace(value: ConnectorAuthorization): Promise<void> {
    const authorization = parseAuthorization(value)
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") await chmod(directory, 0o700)
    const temporaryPath = `${this.filePath}.${String(process.pid)}.${crypto.randomUUID()}.tmp`
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(authorization, null, 2)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, this.filePath)
      if (process.platform !== "win32") await chmod(this.filePath, 0o600)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  clear(): Promise<void> { return rm(this.filePath, { force: true }) }
}

export function resolveConnectorAuthorizationPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.OPENCODE_REMOTE_DATA_DIR?.trim()
  if (configured) return path.join(configured, AUTHORIZATION_FILENAME)
  const dataRoot = environment.XDG_DATA_HOME?.trim()
    ? environment.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share")
  return path.join(dataRoot, "opencode-remote", AUTHORIZATION_FILENAME)
}

function parseAuthorization(value: unknown): ConnectorAuthorization {
  if (!value || typeof value !== "object") throw new Error("Connector authorization has an invalid format")
  const record = value as Record<string, unknown>
  const allowed = new Set(["version", "serviceOrigin", "connectorId", "connectorKeyId", "credential", "credentialExpiresAt", "linkedAt", "trustedClient"])
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("Connector authorization contains unknown fields")
  const trustedClient = connectorPublicIdentitySchema.parse(record.trustedClient)
  if (
    record.version !== 1 ||
    typeof record.serviceOrigin !== "string" ||
    typeof record.connectorId !== "string" || !/^con_[A-Za-z0-9_-]{24}$/u.test(record.connectorId) ||
    typeof record.connectorKeyId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(record.connectorKeyId) ||
    typeof record.credential !== "string" || !/^orc_[A-Za-z0-9_-]{43}$/u.test(record.credential) ||
    typeof record.credentialExpiresAt !== "string" || Number.isNaN(Date.parse(record.credentialExpiresAt))
  ) {
    throw new Error("Connector authorization has an invalid format")
  }
  const serviceOrigin = new URL(record.serviceOrigin).origin
  if (record.linkedAt !== undefined && (typeof record.linkedAt !== "string" || Number.isNaN(Date.parse(record.linkedAt)))) {
    throw new Error("Connector authorization has an invalid linkedAt timestamp")
  }
  return {
    version: 1,
    serviceOrigin,
    connectorId: record.connectorId,
    connectorKeyId: record.connectorKeyId,
    credential: record.credential,
    credentialExpiresAt: record.credentialExpiresAt,
    ...(typeof record.linkedAt === "string" ? { linkedAt: record.linkedAt } : {}),
    trustedClient,
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
