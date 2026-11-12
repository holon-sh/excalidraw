import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { McpRequestContext } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createEvents } from "holon-sh/ext/events";
import { Boards } from "./boards.ts";
import descriptor from "../server.json" with { type: "json" };
import { describe, draw, erase } from "./shapes.ts";
import { bucket, memory } from "./store.ts";
import { type Change, changed, type Cursor, type Element, tools, viewUri } from "./tools.ts";

// Holon reads the server's name, its version, its settings and the hosts it
// may reach from server.json, so the server takes its name and version there too.
const { name, title, description, version, websiteUrl, icons } = descriptor;

export const frontend = new URL("../dist/web/", import.meta.url);
const kept = bucket(process.env) ?? memory();
const boards = new Boards(kept);
const events = createEvents();
/** Tells every other page on a board what `by` changed, as the `board.changed` event. */
const changes = events.event("board.changed", {
  ...changed,
  match: ({ board, by }: Told, page) => board === page.board && by !== page.client,
  transform: ({ board, by, ...change }: Told) => change,
});
type Told = Change & { board: string; by?: string };
/** Where everyone is on each board: a page's cursor while the page follows the board, and any cursor while it moves. */
const cursors = changes.presence<Cursor>(({ board, client }, cursor) => ({
  board,
  by: client,
  ...(cursor ? { cursors: [cursor] } : { gone: [client] }),
}));
/** A person's cursor stays this long after their page stopped following the board, or last sent it if it never did. */
const PERSON_LINGERS = 15_000;
/** An agent's cursor stays this long on what it drew. */
const AGENT_LINGERS = 5000;

/** Stores the elements that win over the board's copies, and tells the other pages on the board. */
async function store(board: string, elements: Element[], by?: string) {
  const stored = await boards.merge(board, elements);
  if (stored.elements.length) changes.emit({ board, by, ...stored });
  return stored;
}

/** Shows an agent's cursor on the shapes it just changed. */
function agent(board: string, { ids, elements }: ReturnType<typeof draw>) {
  const drawn = elements.find(({ id }) => id === ids.at(-1));
  if (!drawn) return;
  const { x, y, width, height } = drawn;
  cursors.set(
    { board, client: "agent" },
    { id: "agent", name: "Agent", x: x + width / 2, y: y + height / 2, selected: ids },
    AGENT_LINGERS,
  );
}

const result = <Output extends object>(output: Output, text = JSON.stringify(output)) => ({
  content: [{ type: "text" as const, text }],
  structuredContent: output,
});

export function createServer({ requestInfo }: McpRequestContext) {
  const server = new McpServer({ name, title, description, version, websiteUrl, icons });
  events.serve(server);
  server.registerTool("read_board", tools.read_board, async ({ board = randomUUID().slice(0, 8) }) => {
    // Holon forwards the installation's public origin. The page is mounted at its root.
    const headers = requestInfo!.headers;
    const origin = `${headers.get("x-forwarded-proto")}://${headers.get("x-forwarded-host")}`;
    return result({ board, url: `${origin}/?board=${board}`, shapes: describe(await boards.elements(board)) });
  });
  server.registerTool("draw", tools.draw, async ({ board, shapes, direction }) => {
    const drawn = draw(await boards.elements(board), shapes, direction);
    await store(board, drawn.elements);
    agent(board, drawn);
    return result({ ids: drawn.ids });
  });
  server.registerTool("erase", tools.erase, async ({ board, ids }) => {
    const erased = erase(await boards.elements(board), ids);
    await store(board, erased.elements);
    return result({ ids: erased.ids });
  });
  server.registerTool("sync", tools.sync, async ({ board, client, since, elements, presence }) => {
    const stored = await store(board, elements, client);
    if (presence) cursors.set({ board, client }, { id: client, ...presence }, PERSON_LINGERS);
    // A page subscribed to the board's changes is told the rest there.
    const changed = since === undefined ? { seq: stored.seq, elements: [] } : await boards.since(board, since);
    const others = changed.elements.filter((element) => !stored.elements.includes(element));
    return result(
      { epoch: boards.epoch, seq: changed.seq, elements: others, cursors: cursors.seen({ board, client }) },
      `${stored.elements.length} stored, ${others.length} returned`,
    );
  });
  server.registerTool("put_image", tools.put_image, async ({ board, id, dataURL }) => {
    await kept.write(`${board}/${id}`, dataURL);
    return result({});
  });
  server.registerTool("get_image", tools.get_image, async ({ board, id }) => {
    const dataURL = await kept.read(`${board}/${id}`);
    return result({ dataURL }, dataURL ? "The image's file." : "The board has no such file.");
  });
  server.registerResource("Board", viewUri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [
      {
        uri: viewUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: await readFile(new URL("../dist/mcp/index.html", import.meta.url), "utf8"),
        // The page loads Excalidraw, React and fonts from esm.sh.
        _meta: { ui: { csp: { resourceDomains: ["https://esm.sh"] } } },
      },
    ],
  }));
  return server;
}

export default createMcpHandler(createServer, { legacy: "reject" });
