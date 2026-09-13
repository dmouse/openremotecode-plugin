import { DatabaseSync } from "node:sqlite"
import path from "node:path"

// Only accepts the disposable fixture's data directory. No provider calls or
// developer conversations are needed to exercise the pinned SDK's read path.
export function seedReasoning(fixture, sessionId, parentId) {
  const now = Date.now()
  const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`
  const db = new DatabaseSync(path.join(fixture.dirs.data, "opencode", "opencode.db"))
  try {
    const directory = fixture.dirs["repo-a"]
    const data = { role: "assistant", parentID: parentId,
      time: { created: now, completed: now }, modelID: "fixture", providerID: "fixture",
      mode: "build", agent: "build", path: { cwd: directory, root: directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
      .run(messageId, sessionId, now, now, JSON.stringify(data))
    const parts = [
      { type: "reasoning", text: "Checking emulator pairing\n\nSynthetic reasoning detail.",
        time: { start: 1000, end: 9000 }, metadata: { signature: "synthetic-local-only" } },
      { type: "reasoning", text: "Updating pairing status", time: { start: 10000, end: 10471 } },
      { type: "text", text: "**Pairing is ready.**" },
    ]
    for (const [index, part] of parts.entries()) {
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(`prt_${messageId.slice(4)}_${index}`, messageId, sessionId, now, now, JSON.stringify(part))
    }
    return messageId
  } finally { db.close() }
}
