import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const CONNECTION_STATUS_FILENAME = "connector-connection-status.json";

export interface ConnectorConnectionStatus {
  version: 1
  connected: boolean
  updatedAt: string
}

export interface ConnectorConnectionStatusStore {
  load(): Promise<ConnectorConnectionStatus | undefined>
  replace(value: ConnectorConnectionStatus): Promise<void>
  clear(): Promise<void>
}

export class FileConnectorConnectionStatusStore implements ConnectorConnectionStatusStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<ConnectorConnectionStatus | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (process.platform !== "win32") {
      const file = await stat(this.filePath);
      if ((file.mode & 0o077) !== 0) throw new Error("Connector connection status file permissions must be 0600");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(contents); } catch {
      throw new Error("Connector connection status file is not valid JSON");
    }
    return parseConnectionStatus(parsed);
  }

  async replace(value: ConnectorConnectionStatus): Promise<void> {
    const status = parseConnectionStatus(value);
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const temporaryPath = `${this.filePath}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(status, null, 2)}\n`);
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

export function resolveConnectorConnectionStatusPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.OPENCODE_REMOTE_DATA_DIR?.trim();
  if (configured) return path.join(configured, CONNECTION_STATUS_FILENAME);
  const dataRoot = environment.XDG_DATA_HOME?.trim()
    ? environment.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(dataRoot, "opencode-remote", CONNECTION_STATUS_FILENAME);
}

function parseConnectionStatus(value: unknown): ConnectorConnectionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connector connection status has an invalid format");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["version", "connected", "updatedAt"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Connector connection status contains unknown fields");
  }
  if (
    record.version !== 1 ||
    typeof record.connected !== "boolean" ||
    typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.updatedAt))
  ) {
    throw new Error("Connector connection status has an invalid format");
  }
  return record as unknown as ConnectorConnectionStatus;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
