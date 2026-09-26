import { chmod, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PRESENCE_DIRECTORY = "directories";
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 5_000;
const MAX_DIRECTORIES = 99;
const MAX_PATH_LENGTH = 4096;

export interface PresenceOptions {
  presencePath: string
  directory: string
  heartbeatMs?: number
}

/// OpenCode loads the plugin once per directory it is launched in, but only one instance holds
/// the relay connection, so the holder cannot see the directories of the others. Each instance
/// therefore announces its own directory here for as long as it runs, and the holder serves the
/// union. This is what makes a globally installed plugin reach every folder OpenCode is used in,
/// while a plugin installed in one project announces only that project: access follows where the
/// plugin is actually loaded, with no configuration.
///
/// An announcement is a file whose modification time is refreshed while the instance lives, so a
/// crashed instance stops granting access within the stale window instead of forever. The file
/// holds only the directory path and sits in the same private data directory as the connector's
/// identity, so it grants nothing to anyone who could not already read that.
export function announceDirectory(options: PresenceOptions): { stop(): Promise<void> } {
  const file = path.join(options.presencePath, `${crypto.randomUUID()}.json`);
  const controller = new AbortController();
  const record = `${JSON.stringify({ version: 1, directory: options.directory })}\n`;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const run = (async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        await mkdir(options.presencePath, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await chmod(options.presencePath, 0o700);
        const now = new Date();
        // Rewritten rather than only touched, so a directory cleared by a stale sweep comes back.
        await writeFile(file, record, { mode: 0o600 });
        await utimes(file, now, now);
      } catch {
        // Filesystem trouble is retried on the next tick; without it the directory only
        // becomes unreachable from a standby instance, never more reachable.
      }
      await delay(heartbeatMs, undefined, { signal: controller.signal, ref: false }).catch(() => {});
    }
  })();

  return {
    stop: async () => {
      controller.abort();
      await run;
      await rm(file, { force: true });
    },
  };
}

/// Directories currently announced by live instances, sorted and deduplicated. Anything malformed
/// or relative is ignored, and stale announcements are swept, never trusted.
export async function liveDirectories(
  presencePath: string,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(presencePath);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(presencePath, name);
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs > staleAfterMs) {
        if (Date.now() - info.mtimeMs > staleAfterMs * 12) await rm(file, { force: true });
        continue;
      }
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      const directory = (value as { version?: unknown; directory?: unknown } | null)?.directory;
      if ((value as { version?: unknown } | null)?.version !== 1 || typeof directory !== "string") continue;
      // eslint-disable-next-line no-control-regex -- deliberately rejects C0 control characters in paths
      if (!path.isAbsolute(directory) || directory.length > MAX_PATH_LENGTH || /[\x00-\x1f]/u.test(directory)) continue;
      found.add(directory);
    } catch {
      // A file removed or half-written between listing and reading is simply not live.
    }
  }
  return [...found].sort().slice(0, MAX_DIRECTORIES);
}

export function resolvePresencePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.OPENCODE_REMOTE_DATA_DIR?.trim();
  if (configured) return path.join(configured, PRESENCE_DIRECTORY);
  const dataRoot = environment.XDG_DATA_HOME?.trim()
    ? environment.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(dataRoot, "opencode-remote", PRESENCE_DIRECTORY);
}
