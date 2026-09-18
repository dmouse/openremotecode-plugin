import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { PairingStart } from "../remote-api-client.js";

const PAIRING_FILENAME = "connector-pairing.json";

export type PendingConnectorPairing = PairingStart & {
  version: 1
  serviceOrigin: string
  connectorKeyId: string
}

export interface ConnectorPairingStore {
  load(): Promise<PendingConnectorPairing | undefined>
  replace(value: PendingConnectorPairing): Promise<void>
  clear(): Promise<void>
}

export class FileConnectorPairingStore implements ConnectorPairingStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<PendingConnectorPairing | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (process.platform !== "win32") {
      const file = await stat(this.filePath);
      if ((file.mode & 0o077) !== 0) throw new Error("Connector pairing file permissions must be 0600");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(contents); } catch {
      throw new Error("Connector pairing file is not valid JSON");
    }
    return parsePendingPairing(parsed);
  }

  async replace(value: PendingConnectorPairing): Promise<void> {
    const pairing = parsePendingPairing(value);
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const temporaryPath = `${this.filePath}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(pairing, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.filePath);
      if (process.platform !== "win32") await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  clear(): Promise<void> { return rm(this.filePath, { force: true }); }
}

export function resolveConnectorPairingPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.OPENCODE_REMOTE_DATA_DIR?.trim();
  if (configured) return path.join(configured, PAIRING_FILENAME);
  const dataRoot = environment.XDG_DATA_HOME?.trim()
    ? environment.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(dataRoot, "opencode-remote", PAIRING_FILENAME);
}

function parsePendingPairing(value: unknown): PendingConnectorPairing {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connector pairing has an invalid format");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "version", "serviceOrigin", "connectorKeyId", "pairingId", "pairingSecret", "userCode",
    "serviceId", "verificationUri", "expiresAt", "pollIntervalSeconds",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Connector pairing contains unknown fields");
  }
  if (
    record.version !== 1 ||
    typeof record.serviceOrigin !== "string" || new URL(record.serviceOrigin).origin !== record.serviceOrigin ||
    typeof record.connectorKeyId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(record.connectorKeyId) ||
    typeof record.pairingId !== "string" || !/^par_[A-Za-z0-9_-]{24}$/u.test(record.pairingId) ||
    typeof record.pairingSecret !== "string" || !/^orp_[A-Za-z0-9_-]{43}$/u.test(record.pairingSecret) ||
    typeof record.userCode !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(record.userCode) ||
    typeof record.serviceId !== "string" || record.serviceId === "" ||
    typeof record.verificationUri !== "string" || record.verificationUri === "" ||
    typeof record.expiresAt !== "string" || Number.isNaN(Date.parse(record.expiresAt)) ||
    typeof record.pollIntervalSeconds !== "number" || !Number.isInteger(record.pollIntervalSeconds) ||
    record.pollIntervalSeconds < 1 || record.pollIntervalSeconds > 30
  ) {
    throw new Error("Connector pairing has an invalid format");
  }
  return record as unknown as PendingConnectorPairing;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
