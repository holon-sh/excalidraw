import { readFile } from "node:fs/promises";
import { createServer as listen } from "node:http";
import type { AddressInfo } from "node:net";
import { extname } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer, frontend } from "./server.ts";

// Runs the board without Holon: the page at /, and the MCP endpoint at /mcp/excalidraw.
// Holon answers 2025-era clients in front of the app; here the board answers them itself.
const mcp = createMcpHandler(createServer);
const { PORT = "3000", HOST = "127.0.0.1" } = process.env;
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
};

const server = listen(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname === "/mcp" || url.pathname === "/mcp/excalidraw") {
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      // read_board links to the page at the origin a proxy forwards, or else at this server.
      if (!headers.has("x-forwarded-host")) headers.set("x-forwarded-host", url.host);
      if (!headers.has("x-forwarded-proto")) headers.set("x-forwarded-proto", "http");
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const response = await mcp.fetch(
        new Request(url, {
          method: req.method,
          headers,
          body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
          signal: gone.signal,
          duplex: "half",
        } as RequestInit),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return void res.end();
      Readable.fromWeb(response.body as NodeReadableStream).pipe(res);
      return;
    }
    const file = new URL(url.pathname.endsWith("/") ? "index.html" : `.${url.pathname}`, frontend);
    if (!file.href.startsWith(frontend.href)) throw Object.assign(new Error(), { code: "ENOENT" });
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file.pathname)] ?? "application/octet-stream" });
    res.end(body);
  } catch (error) {
    const missing = (error as { code?: string }).code === "ENOENT";
    if (!missing) console.error(error);
    if (!res.headersSent) res.writeHead(missing ? 404 : 500);
    res.end();
  }
});

server.listen(Number(PORT), HOST, () => {
  const { port } = server.address() as AddressInfo;
  const origin = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${port}`;
  console.log(`Board at ${origin}/ and its MCP endpoint at ${origin}/mcp/excalidraw`);
});
