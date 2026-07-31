import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { makePool } from "./db/pool.js";
import { bootstrap } from "./db/bootstrap.js";
import { paymentProvider } from "./integrations/mockProvider.js";

const app = express();
app.use(express.json());

// One shared connection pool; ensure schema + demo data exist at startup.
const pool = makePool();
await bootstrap(pool);

// Plain HTTP health endpoint (not MCP). Hosting platforms ping this to know
// the service is alive, and it's an easy human/curl sanity check.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "commerce-ops-mcp" });
});

/**
 * The MCP endpoint.
 *
 * We run the Streamable HTTP transport in STATELESS mode: a brand-new server
 * and transport are created for every request, and torn down when the response
 * closes. Nothing about a connection is remembered server-side.
 *
 * Why stateless:
 *  - All real state lives in the database, not in server memory.
 *  - The service can be restarted or horizontally scaled with zero session
 *    affinity concerns, which matters on a hosted platform.
 *  - It's simpler to reason about: each request is independent.
 */
app.post("/mcp", async (req, res) => {
  const server = buildMcpServer(pool, paymentProvider);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // undefined = stateless
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// In stateless mode there is no long-lived stream to GET or session to DELETE.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST for MCP." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`commerce-ops-mcp listening on http://localhost:${PORT}/mcp`);
});
