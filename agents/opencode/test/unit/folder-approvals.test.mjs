import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { FileFolderApprovalStore, resolveFolderApprovalsPath } from "../../dist/folder-approvals.js"
import { WorkspaceRegistry } from "../../dist/chat/workspace.js"

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "folder-approvals-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, "private", "approved-folders")
  const a = path.join(root, "a"), b = path.join(root, "b")
  await Promise.all([mkdir(a), mkdir(b), mkdir(path.dirname(directory))])
  return { root, directory, a, b, store: new FileFolderApprovalStore(directory) }
}

test("no default grant; local approval persists across store and registry restarts", async (t) => {
  const { store, directory, a, b } = await fixture(t)
  const registry = () => new WorkspaceRegistry(undefined, [], () => store.list())
  assert.deepEqual(await registry().listVerified(), [])
  assert.equal((await store.inspect(a)).enabled, false)
  const approved = await store.inspect(a)
  await store.setEnabled(approved, true)
  assert.equal((await new FileFolderApprovalStore(directory).inspect(a)).enabled, true)
  assert.deepEqual((await registry().listVerified()).map((f) => f.path), [a])
  await assert.rejects(registry().resolvePath(b), { code: "access_denied" })
  const entries = await readdir(directory)
  assert.equal(entries.length, 1)
  assert.match(entries[0], /^[a-f0-9]{64}\.json$/)
  assert.equal(JSON.parse(await readFile(path.join(directory, entries[0]), "utf8")).path, a)
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(path.join(directory, entries[0]))).mode & 0o777, 0o600)
  }
  const live = registry()
  const [project] = await live.listVerified()
  await store.setEnabled(approved, false)
  assert.deepEqual(await live.listVerified(), [])
  await assert.rejects(live.get(project.id), { code: "context_expired" })
  await store.setEnabled(approved, false) // idempotent
})

test("separate TUIs approving different folders cannot lose each other's grants", async (t) => {
  const { directory, a, b, store } = await fixture(t)
  const other = new FileFolderApprovalStore(directory)
  await Promise.all([store.setEnabled(await store.inspect(a), true), other.setEnabled(await other.inspect(b), true)])
  assert.deepEqual((await store.list()).map((f) => f.path), [a, b])
  await store.setEnabled(await store.inspect(a), false)
  assert.deepEqual((await other.list()).map((f) => f.path), [b])
})

test("symlink aliases approve only the canonical target, and replacements require new consent", async (t) => {
  const { a, b, root, store } = await fixture(t)
  const alias = path.join(root, "alias")
  await symlink(a, alias)
  const reviewed = await store.inspect(alias)
  assert.equal(reviewed.path, a)
  await store.setEnabled(reviewed, true)
  const registry = new WorkspaceRegistry(undefined, [], () => store.list())
  const [originalProject] = await registry.listVerified()
  await rm(alias); await symlink(b, alias)
  assert.equal((await store.inspect(alias)).enabled, false)
  await rename(a, `${a}-old`); await mkdir(a)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(store.setEnabled(reviewed, true), /changed/)
  const replacement = await store.inspect(a)
  assert.equal(replacement.enabled, false)
  await store.setEnabled(replacement, true)
  assert.equal((await store.inspect(a)).enabled, true)
  assert.equal((await registry.get(originalProject.id)).ino, replacement.ino,
    "explicit reapproval must work in the existing connector without a restart")
  const stale = new WorkspaceRegistry(undefined, [], async () => [reviewed])
  assert.deepEqual(await stale.listVerified(), [], "an approval read before replacement cannot pin the new folder")
  await rm(a, { recursive: true })
  assert.deepEqual(await store.list(), [])
})

test("malformed, oversized, incorrectly named, symlinked and public records grant nothing", async (t) => {
  const { a, b, root, directory, store } = await fixture(t)
  await store.setEnabled(await store.inspect(a), true)
  const [name] = await readdir(directory), file = path.join(directory, name)
  const original = await readFile(file, "utf8")
  for (const contents of ["not json", " ".repeat(8193), JSON.stringify({ ...JSON.parse(original), path: b }),
    JSON.stringify({ ...JSON.parse(original), version: 2 }), JSON.stringify({ ...JSON.parse(original), extra: true })]) {
    await writeFile(file, contents)
    assert.deepEqual(await store.list(), [])
  }
  await writeFile(file, original)
  if (process.platform !== "win32") {
    await chmod(file, 0o644)
    assert.deepEqual(await store.list(), [])
    await chmod(file, 0o600)
  }
  await rename(file, path.join(root, "record"))
  await symlink(path.join(root, "record"), file)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(store.inspect("relative"))
  await assert.rejects(store.inspect(`${a}\n`))
  await assert.rejects(store.inspect(path.join(root, "record")))
})

test("approvals are isolated by the connector data directory", () => {
  assert.equal(resolveFolderApprovalsPath({ OPENCODE_REMOTE_DATA_DIR: "/private/connector-a" }),
    "/private/connector-a/approved-folders")
  assert.notEqual(resolveFolderApprovalsPath({ OPENCODE_REMOTE_DATA_DIR: "/private/connector-a" }),
    resolveFolderApprovalsPath({ OPENCODE_REMOTE_DATA_DIR: "/private/connector-b" }))
})
