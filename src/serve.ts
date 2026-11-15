import { createMcpHandler } from "@modelcontextprotocol/server";
import { serve } from "holon-sh/serve";
import { createServer, frontend } from "./server.ts";

// Runs the board without Holon: the page at /, and the MCP endpoint at /mcp/excalidraw.
// Holon answers 2025-era clients in front of the app; here the board answers them itself.
await serve({ default: createMcpHandler(createServer), frontend });
