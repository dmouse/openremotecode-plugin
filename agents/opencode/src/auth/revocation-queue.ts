import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { RemoteAPIClient } from "../remote-api-client.js";
import { validateServiceOrigin } from "../service-origin.js";

const REVOCATION_QUEUE_FILENAME = "connector-revocation-queue.json";

/**
 * A credential whose local authorization has already been withdrawn but whose server-side
 * revocation has not yet been confirmed. Local disablement must never wait on this succeeding.
 */
export interface QueuedRevocation {
  version: 1
  serviceOrigin: string
  credential: string
}

export interface RevocationQueueStore {
  load(): Promise<QueuedRevocation | undefined>
  replace(value: QueuedRevocation): Promise<void>
  clear(): Promise<void>
}

export class FileRevocationQueueStore implements RevocationQueueStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<QueuedRevocation | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (process.platform !== "win32") {
      const file = await stat(this.filePath);
      if ((file.mode & 0o077) !== 0) {
        throw new Error("Connector revocation queue file permissions must be 0600");
      }
    }
    let parsed: unknown;
    try { parsed = JSON.parse(contents); } catch {
      throw new Error("Connector revocation queue file is not valid JSON");
    }
    return parseQueuedRevocation(parsed);
  }

  async replace(value: QueuedRevocation): Promise<void> {
    const revocation = parseQueuedRevocation(value);
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    const temporaryPath = `${this.filePath}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(revocation, null, 2)}\n`);
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

export function resolveRevocationQueuePath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.OPENCODE_REMOTE_DATA_DIR?.trim();
  if (configured) return path.join(configured, REVOCATION_QUEUE_FILENAME);
  const dataRoot = environment.XDG_DATA_HOME?.trim()
    ? environment.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(dataRoot, "opencode-remote", REVOCATION_QUEUE_FILENAME);
}

function parseQueuedRevocation(value: unknown): QueuedRevocation {
  if (!value || typeof value !== "object") throw new Error("Connector revocation queue entry has an invalid format");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["version", "serviceOrigin", "credential"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Connector revocation queue entry contains unknown fields");
  }
  if (
    record.version !== 1 ||
    typeof record.serviceOrigin !== "string" || new URL(record.serviceOrigin).origin !== record.serviceOrigin ||
    typeof record.credential !== "string" || !/^orc_[A-Za-z0-9_-]{43}$/u.test(record.credential)
  ) {
    throw new Error("Connector revocation queue entry has an invalid format");
  }
  return { version: 1, serviceOrigin: record.serviceOrigin, credential: record.credential };
}

/**
 * Retries a server-side revocation left behind by a local disable that could not reach the
 * service. Never throws: a still-unreachable or misbehaving server must not block plugin
 * startup, and the entry simply stays queued for the next attempt.
 */
export async function attemptQueuedRevocation(store: RevocationQueueStore, signal: AbortSignal): Promise<void> {
  let queued: QueuedRevocation | undefined;
  try { queued = await store.load(); } catch { return; }
  if (!queued) return;
  try {
    const serviceOrigin = validateServiceOrigin(queued.serviceOrigin);
    await new RemoteAPIClient(serviceOrigin).revokeConnector(queued.credential, signal);
    await store.clear();
  } catch {
    // Left queued; the next start retries.
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
