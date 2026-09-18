import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  deserializeConnectorIdentity,
  generateConnectorIdentity,
  type ConnectorIdentity,
} from "@openremotecode/protocol";

const IDENTITY_FILENAME = "connector-identity.json";

export class FileConnectorIdentityStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  clear(): Promise<void> { return rm(this.#filePath, { force: true }); }

  async loadOrCreate(): Promise<ConnectorIdentity> {
    const existing = await this.#loadIfPresent();
    if (existing) return existing;

    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);

    const generated = await generateConnectorIdentity();
    const temporaryPath = `${this.#filePath}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);

    try {
      await handle.writeFile(`${JSON.stringify(generated.serialized, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(temporaryPath, this.#filePath);
      return generated.identity;
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      const concurrentIdentity = await this.#loadIfPresent();
      if (!concurrentIdentity) {
        throw new Error("Connector identity was created concurrently but cannot be read", { cause: error });
      }
      return concurrentIdentity;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async #loadIfPresent(): Promise<ConnectorIdentity | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) return undefined;
      throw error;
    }

    if (process.platform !== "win32") {
      const file = await stat(this.#filePath);
      if ((file.mode & 0o077) !== 0) {
        throw new Error("Connector identity file permissions must be 0600");
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error("Connector identity file is not valid JSON");
    }
    return deserializeConnectorIdentity(parsed);
  }
}

export function resolveConnectorIdentityPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.OPENCODE_REMOTE_DATA_DIR?.trim();
  if (configured) return path.join(configured, IDENTITY_FILENAME);

  const dataRoot = environment.XDG_DATA_HOME?.trim()
    ? environment.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(dataRoot, "opencode-remote", IDENTITY_FILENAME);
}

function isFileNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
