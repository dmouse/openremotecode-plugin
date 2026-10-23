import { chmod, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  sessionIds?: () => readonly string[]
}

/// One instance holds the relay connection; these local announcements let it
/// recover locally open moved chats from another TUI. Directory access itself
/// comes only from persistent folder approvals, never these announcements.
///
/// An announcement is a file whose modification time is refreshed while the instance lives, so a
/// crashed instance stops offering local recovery candidates within the stale window. The file
/// holds the launch directory and bounded IDs of locally open tabs, never chat content. It sits
/// in the same private data directory as the connector's identity.
export function announceDirectory(options: PresenceOptions): { stop(): Promise<void> } {
  const file = path.join(options.presencePath, `${crypto.randomUUID()}.json`);
  const controller = new AbortController();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  const run = (async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        await mkdir(options.presencePath, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await chmod(options.presencePath, 0o700);
        const now = new Date();
        const sessionIds = [...new Set(options.sessionIds?.() ?? [])].filter(validSessionId).slice(0, 64);
        const record = `${JSON.stringify({ version: 1, directory: options.directory, sessionIds })}\n`;
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
  return [...new Set((await liveAnnouncements(presencePath, staleAfterMs)).map((entry) => entry.directory))]
    .sort().slice(0, MAX_DIRECTORIES);
}

/// Only sessions explicitly open in a local TUI, never its server-wide cached session list.
/// The holder can recover these chats even if another TUI moved them before it took ownership.
export async function liveSessionIds(presencePath: string, directory: string): Promise<string[]> {
  const announcements = await liveAnnouncements(presencePath, DEFAULT_STALE_AFTER_MS);
  const ids = await Promise.all(announcements.map(async (entry) =>
    await realpath(entry.directory).catch(() => undefined) === directory ? entry.sessionIds : []));
  return [...new Set(ids.flat())].slice(0, 2048);
}

function validSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,256}$/u.test(id);
}

async function liveAnnouncements(presencePath: string, staleAfterMs: number):
    Promise<{ directory: string; sessionIds: string[] }[]> {
  let names: string[];
  try {
    names = await readdir(presencePath);
  } catch {
    return [];
  }
  const found: { directory: string; sessionIds: string[] }[] = [];
  for (const name of names.sort().slice(0, 256)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(presencePath, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 32_768) continue;
      if (Date.now() - info.mtimeMs > staleAfterMs) {
        if (Date.now() - info.mtimeMs > staleAfterMs * 12) await rm(file, { force: true });
        continue;
      }
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      const directory = (value as { version?: unknown; directory?: unknown } | null)?.directory;
      if ((value as { version?: unknown } | null)?.version !== 1 || typeof directory !== "string") continue;
      // eslint-disable-next-line no-control-regex -- deliberately rejects C0 control characters in paths
      if (!path.isAbsolute(directory) || directory.length > MAX_PATH_LENGTH || /[\x00-\x1f]/u.test(directory)) continue;
      const ids = (value as { sessionIds?: unknown }).sessionIds;
      const sessionIds = Array.isArray(ids) && ids.length <= 64 && ids.every(validSessionId) ? ids : [];
      found.push({ directory, sessionIds });
    } catch {
      // A file removed or half-written between listing and reading is simply not live.
    }
  }
  return found;
}

export function resolvePresencePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.OPENCODE_REMOTE_DATA_DIR?.trim();
  if (configured) return path.join(configured, PRESENCE_DIRECTORY);
  const dataRoot = environment.XDG_DATA_HOME?.trim()
    ? environment.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(dataRoot, "opencode-remote", PRESENCE_DIRECTORY);
}
