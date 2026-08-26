// Dual-era fixture: the SAME factory serves 2026-07-28 (server/discover) and
// legacy (initialize) clients — serveStdio owns the era decision per connection.
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

serveStdio(
  () => {
    const server = new McpServer({ name: "v2-fixture", version: "1.0.0" }, { capabilities: { tools: {} } })
    server.registerTool(
      "echo",
      {
        description: "echo the input back",
        inputSchema: { text: z.string() },
      },
      async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
    )
    return server
  },
  {
    onerror: (e) => console.error("[fixture]", e.message),
  },
)
