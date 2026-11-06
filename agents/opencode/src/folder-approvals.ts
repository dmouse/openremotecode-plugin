import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, opendir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { utf16Length } from "@openremotecode/protocol";
import { resolveConnectorAuthorizationPath } from "./auth/authorization-store.js";

const MAX_FOLDERS = 100;
// eslint-disable-next-line no-control-regex -- local paths are untrusted too
const directoryPath = z.string().check(utf16Length(1, 4096)).refine((value) => path.isAbsolute(value) && !/[\x00-\x1f]/u.test(value));
const folderSchema = z.object({
  version: z.literal(1),
  path: directoryPath,
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
}).strict();
export type ApprovedFolder = z.infer<typeof folderSchema>;
export interface FolderStatus extends ApprovedFolder { enabled: boolean }
export interface FolderApprovalStore {
  list(): Promise<ApprovedFolder[]>
  inspect(directory: string): Promise<FolderStatus>
  setEnabled(folder: ApprovedFolder, enabled: boolean): Promise<void>
}

const filename = (directory: string): string => `${createHash("sha256").update(directory).digest("hex")}.json`;

/// One atomic record per canonical folder: concurrent approvals from different
/// TUIs cannot overwrite each other. No live presence or startup directory grants
/// access. Persist filesystem identity so replacing a folder requires reapproval.
export class FileFolderApprovalStore implements FolderApprovalStore {
  constructor(private readonly directory: string) {}

  async list(): Promise<ApprovedFolder[]> {
    let entries;
    try { entries = await opendir(this.directory); } catch (error) {
      if (isMissing(error)) return [];
      throw new Error("Folder approvals are unavailable", { cause: error });
    }
    const folders: ApprovedFolder[] = [];
    let count = 0;
    for await (const entry of entries) {
      if (++count > MAX_FOLDERS) throw new Error("Too many folder approval records");
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      try {
        const folder = await this.#read(entry.name);
        if (filename(folder.path) === entry.name && await matches(folder)) folders.push(folder);
      } catch {
        // Invalid, missing or unreadable records grant nothing, never a fallback.
      }
    }
    return folders.sort((a, b) => a.path.localeCompare(b.path));
  }

  async inspect(directory: string): Promise<FolderStatus> {
    const canonical = directoryPath.parse(await realpath(directoryPath.parse(directory)));
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error("Folder is unavailable");
    const folder: ApprovedFolder = { version: 1, path: canonical, dev: info.dev, ino: info.ino };
    return { ...folder, enabled: (await this.list()).some((entry) => same(entry, folder)) };
  }

  async setEnabled(input: ApprovedFolder, enabled: boolean): Promise<void> {
    const folder = folderSchema.parse({ version: input.version, path: input.path, dev: input.dev, ino: input.ino });
    const file = path.join(this.directory, filename(folder.path));
    if (!enabled) { await rm(file, { force: true }); return; }
    if (!await matches(folder)) throw new Error("Folder changed; review it again");
    const approved = await this.list();
    if (approved.length >= MAX_FOLDERS && !approved.some((entry) => entry.path === folder.path)) {
      throw new Error("Folder approval limit reached");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
    // Temporary files are siblings, not approval-directory entries.
    const temporary = `${this.directory}.${String(process.pid)}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(folder)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      if (!await matches(folder)) throw new Error("Folder changed; review it again");
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }

  async #read(name: string): Promise<ApprovedFolder> {
    const handle = await open(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 8192 || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
        throw new Error("Invalid folder approval");
      }
      // Bound the read itself too: a concurrently growing file must not turn a
      // previously small stat into an unbounded allocation.
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) throw new Error("Invalid folder approval");
      return folderSchema.parse(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
    } finally { await handle.close(); }
  }
}

async function matches(folder: ApprovedFolder): Promise<boolean> {
  try {
    if (await realpath(folder.path) !== folder.path) return false;
    const info = await stat(folder.path);
    return info.isDirectory() && info.dev === folder.dev && info.ino === folder.ino;
  } catch { return false; }
}
function same(a: ApprovedFolder, b: ApprovedFolder): boolean {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino;
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function resolveFolderApprovalsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(resolveConnectorAuthorizationPath(environment)), "approved-folders");
}
