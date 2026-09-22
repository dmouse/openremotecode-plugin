import { chmod, link, mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const INSTANCE_LOCK_FILENAME = "connector-instance.lock";
const DEFAULT_HEARTBEAT_MS = 1_000;
const DEFAULT_STALE_AFTER_MS = 5_000;
const DEFAULT_POLL_MS = 1_000;

interface LockRecord {
  version: 1
  token: string
  pid: number
  acquiredAt: string
}

export interface OwnershipOptions {
  lockPath: string
  /// Starts everything that must exist only once per connector identity. Called each time
  /// this instance becomes the owner.
  onAcquired: () => Promise<void>
  /// Tears that down. Called when ownership is lost to another instance and on stop().
  onLost: () => Promise<void>
  /// Called once per standby period, when another live instance is found to own the lock.
  onStandby?: () => void
  heartbeatMs?: number
  staleAfterMs?: number
  pollMs?: number
}

export interface OwnershipSupervisor {
  stop(): Promise<void>
}

/// The relay admits one connection per connector identity and evicts the older one when the
/// same identity connects again. OpenCode loads a plugin instance for every directory it
/// works in, and each instance shares this machine's identity, so without coordination they
/// evict each other in a reconnect loop and the phone never reaches a stable connector.
///
/// Exactly one instance per state directory owns the connection at a time. The others wait
/// and take over when the owner stops or stops refreshing the lock.
///
/// The owner proves it is alive by refreshing the lock file's modification time; a lock left
/// by a crashed process goes stale rather than blocking every later instance. Process IDs are
/// deliberately not used for liveness: they are reused, and differ between containers that
/// share a data directory. Every refresh also re-reads the lock's token, so an owner that
/// was suspended past the stale window and lost the lock notices and stops instead of
/// contending. Taking over a stale lock is not atomic; a rare simultaneous takeover resolves
/// itself at the next refresh, when the loser sees a foreign token.
export function superviseOwnership(options: OwnershipOptions): OwnershipSupervisor {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const token = crypto.randomUUID();
  const controller = new AbortController();
  let owned = false;
  let standbyAnnounced = false;

  const run = (async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        if (!owned) {
          if (await tryAcquire(options.lockPath, token, staleAfterMs)) {
            owned = true;
            standbyAnnounced = false;
            try {
              await options.onAcquired();
            } catch (error) {
              // Holding the lock without a running relay would starve the other instances.
              owned = false;
              await releaseLock(options.lockPath, token);
              throw error;
            }
          } else if (!standbyAnnounced) {
            standbyAnnounced = true;
            options.onStandby?.();
          }
        } else if (!(await refreshLock(options.lockPath, token))) {
          owned = false;
          await options.onLost();
        }
      } catch {
        // Filesystem trouble is retried on the next tick. An owner that keeps failing to
        // refresh goes stale and is replaced; it then finds the foreign token and stops.
      }
      await delay(owned ? heartbeatMs : pollMs, undefined, { signal: controller.signal, ref: false }).catch(() => {});
    }
  })();

  return {
    stop: async () => {
      controller.abort();
      await run;
      if (!owned) return;
      owned = false;
      try { await options.onLost(); } finally { await releaseLock(options.lockPath, token); }
    },
  };
}

export function resolveConnectorInstanceLockPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.OPENCODE_REMOTE_DATA_DIR?.trim();
  if (configured) return path.join(configured, INSTANCE_LOCK_FILENAME);
  const dataRoot = environment.XDG_DATA_HOME?.trim()
    ? environment.XDG_DATA_HOME
    : path.join(homedir(), ".local", "share");
  return path.join(dataRoot, "opencode-remote", INSTANCE_LOCK_FILENAME);
}

async function tryAcquire(lockPath: string, token: string, staleAfterMs: number): Promise<boolean> {
  const directory = path.dirname(lockPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createLock(lockPath, token)) return true;
    const held = await readHeld(lockPath);
    // Released between the failed create and the read; try again straight away.
    if (!held) continue;
    if (Date.now() - held.modifiedMs <= staleAfterMs) return false;
    // Only remove the exact stale lock that was judged stale, never a fresh one that
    // replaced it in the meantime.
    const current = await readHeld(lockPath);
    if (current?.raw !== held.raw) return false;
    await rm(lockPath, { force: true });
  }
  return false;
}

// The record is written to a private file and hard-linked into place so the lock appears
// atomically and complete: no reader ever sees an empty or partial lock, and link() fails
// with EEXIST rather than replacing a lock that already exists.
async function createLock(lockPath: string, token: string): Promise<boolean> {
  const record: LockRecord = { version: 1, token, pid: process.pid, acquiredAt: new Date().toISOString() };
  const temporaryPath = `${lockPath}.${String(process.pid)}.${token}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporaryPath, lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readHeld(lockPath: string): Promise<{ raw: string; record: LockRecord | undefined; modifiedMs: number } | undefined> {
  try {
    const [raw, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    return { raw, record: parseRecord(raw), modifiedMs: info.mtimeMs };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function refreshLock(lockPath: string, token: string): Promise<boolean> {
  const held = await readHeld(lockPath);
  if (held?.record?.token !== token) return false;
  const now = new Date();
  await utimes(lockPath, now, now);
  return true;
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  const held = await readHeld(lockPath).catch(() => undefined);
  if (held?.record?.token === token) await rm(lockPath, { force: true });
}

function parseRecord(raw: string): LockRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || typeof record.token !== "string" || typeof record.pid !== "number" ||
        typeof record.acquiredAt !== "string") return undefined;
    return record as unknown as LockRecord;
  } catch {
    return undefined;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
