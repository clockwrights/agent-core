// Minimal stdio MCP server whose tools declare annotations (used by toolApproval.test.ts).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const schema = { type: "object", properties: {} };
const server = new Server({ name: "annotated", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "lookup", inputSchema: schema, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: "wipe", inputSchema: schema, annotations: { destructiveHint: true, idempotentHint: true } },
    { name: "plain", inputSchema: schema },
    { name: "odd", inputSchema: schema, annotations: { title: "Odd" } }
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: `ran ${request.params.name}` }]
}));

await server.connect(new StdioServerTransport());
