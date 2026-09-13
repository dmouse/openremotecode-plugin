import { DatabaseSync } from "node:sqlite"
import path from "node:path"

// Synthetic data in a disposable fixture database only; no provider is called.
export function seedSubtask(fixture, parentSessionId, childSessionId, parentUserId) {
  const db = new DatabaseSync(path.join(fixture.dirs.data, "opencode", "opencode.db"))
  const now = Date.now()
  const directory = fixture.dirs["repo-a"]
  function insert(sessionId, data, parts) {
    const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
      .run(id, sessionId, data.time.created, Math.max(now, data.time.created), JSON.stringify(data))
    for (const [index, part] of parts.entries()) {
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(`prt_${id.slice(4)}_${String(index).padStart(3, "0")}`, id, sessionId, now, now, JSON.stringify(part))
    }
    return id
  }
  const assistant = (parentID) => ({ role: "assistant", parentID,
    time: { created: now - 81000, completed: now }, modelID: "fixture", providerID: "fixture",
    mode: "build", agent: "build", path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" })
  try {
    const childUser = insert(childSessionId, { role: "user", time: { created: now - 82000 }, agent: "explore",
      model: { providerID: "fixture", modelID: "fixture" } }, [{ type: "text", text: "Inspect the synthetic palette." }])
    insert(childSessionId, assistant(childUser), [
      ...Array.from({ length: 15 }, (_, i) => ({ type: "tool", tool: "read", callID: `call_${i}`,
        state: { status: "completed", input: {}, title: "Synthetic palette read", output: "synthetic-local-only",
          metadata: {}, time: { start: now - 80000, end: now - 1000 } } })),
      { type: "text", text: "**The palette uses deep green.**" },
    ])
    // Forks rebuild row timestamps from message data. Keep the synthetic
    // parent's clocks consistent with its position after the existing history.
    const latest = db.prepare("SELECT COALESCE(MAX(time_created), 0) AS latest FROM message WHERE session_id = ?")
      .get(parentSessionId).latest
    const created = Math.max(now, latest + 1)
    return insert(parentSessionId, { ...assistant(parentUserId), time: { created, completed: created } }, [{ type: "tool", tool: "task", callID: "call_task",
      state: { status: "completed", input: { description: "Inspect mobile color palette", subagent_type: "explore", prompt: "synthetic-local-only" },
        title: "Inspect mobile color palette", output: "synthetic-local-only",
        metadata: { sessionId: childSessionId, model: "synthetic-local-only" }, time: { start: now - 83000, end: now } } }])
  } finally { db.close() }
}
