// Minimal, inert stdio peer for the pinned OpenCode MCP integration test.
// It advertises no callable tools and never contacts external services.
import { createInterface } from "node:readline"

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  const result = request.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} },
      serverInfo: { name: "status-fixture", version: "1.0.0" } }
    : request.method === "tools/list" ? { tools: [] }
    : request.method === "ping" ? {} : undefined
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
    ...(result ? { result } : { error: { code: -32601, message: "Method not found" } }) }) + "\n")
}
