import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createApps } from "holon-sh/runtime";
import type { Element } from "../src/tools.ts";

const element = (id: string, version: number, versionNonce = 0): Element => ({
  id,
  version,
  versionNonce,
  isDeleted: false,
});

/** Runs the board on its own, and calls it as pages and agents do: over MCP. */
async function start(t: TestContext, env: Record<string, string> = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("S3_")));
  const server = spawn(process.execPath, ["src/serve.ts"], {
    env: { ...inherited, ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => server.kill());
  const [, origin] = (await once(server.stdout, "data")).toString().match(/Board at (\S+)\//)!;
  const endpoint = `${origin}/mcp/excalidraw`;
  const board = createApps({ name: "page", version: "1.0.0" }, { excalidraw: null }, { excalidraw: { endpoint } }).excalidraw!;
  t.after(() => board.close());
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result = (await board.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: unknown };
    // A refused call says why in its text, which is what an agent reads.
    if (result.isError) throw new Error(result.content[0]!.text);
    return result.structuredContent;
  };
  /** The board's elements as a page reads them, erased ones included. */
  const elements = async (id = "b") =>
    new Map<string, Element>(
      (await call("sync", { board: id, client: "reader", since: 0, elements: [] })).elements.map((each: Element) => [each.id, each]),
    );
  /** The board's shapes as an agent reads them, by id. */
  const shapes = async (id = "b") =>
    Object.fromEntries((await call("read_board", { board: id })).shapes.map((shape: { id: string }) => [shape.id, shape]));
  return { endpoint, board, call, elements, shapes, stop: () => server.kill() };
}

async function until(condition: () => unknown) {
  for (const deadline = Date.now() + 5000; !condition(); await sleep(10))
    if (Date.now() > deadline) throw new Error("Timed out waiting");
}

test("a board keeps each element's winning version in its bucket, saves a burst of edits once, and outlives the server that held it", { timeout: 20_000 }, async (t) => {
  // A bucket behind an S3-compatible API, which keeps what it is sent and says when each object was written.
  const objects = new Map<string, { body: string; written: number }>();
  const written: string[] = [];
  const s3 = createServer(async (request, response) => {
    const key = request.url!;
    if (request.method === "PUT") {
      let body = "";
      for await (const chunk of request) body += chunk;
      objects.set(key, { body, written: Date.now() });
      written.push(key);
      return void response.end();
    }
    const object = objects.get(key);
    if (!object) return void response.writeHead(404).end();
    response.writeHead(200, { "last-modified": new Date(object.written).toUTCString() }).end(object.body);
  });
  s3.listen(0, "127.0.0.1");
  await once(s3, "listening");
  t.after(() => s3.close());
  const env = { S3_HOST: `http://127.0.0.1:${(s3.address() as AddressInfo).port}`, S3_ACCESS_KEY_ID: "id", S3_SECRET_ACCESS_KEY: "secret" };

  const first = await start(t, env);
  const erasedLongAgo = { ...element("gone", 1), isDeleted: true, updated: 0 };
  await first.call("sync", { board: "b", client: "you", elements: [element("a", 2, 5), element("c", 1), erasedLongAgo] });
  // Excalidraw's rule: the higher version, and the lower nonce between equal versions.
  await first.call("sync", { board: "b", client: "me", elements: [element("a", 1, 0), element("a", 2, 9), element("a", 2, 3), element("c", 2)] });
  assert.deepEqual([...(await first.elements()).values()], [element("a", 2, 3), element("c", 2), erasedLongAgo]);
  await first.call("put_image", { board: "b", id: "cat", dataURL: "data:image/png;base64,AAAA" });
  await until(() => written.includes("/excalidraw-boards/b.json"));
  await sleep(200);
  assert.deepEqual(written.sort(), ["/excalidraw-boards/b.json", "/excalidraw-boards/b/cat"], "a burst of edits is one save");

  // A lifecycle rule deletes what nobody has written for a while, so a board read after a month is written again.
  first.stop();
  objects.get("/excalidraw-boards/b.json")!.written -= 31 * 24 * 60 * 60_000;
  const second = await start(t, env);
  // A page cannot tell which of the saved elements it has, so each counts as the latest. An erasure a day old is not kept.
  const { epoch, ...read } = await second.call("sync", { board: "b", client: "me", since: 3, elements: [] });
  assert.deepEqual(read, { seq: 5, elements: [element("a", 2, 3), element("c", 2)], cursors: [] });
  assert.deepEqual(await second.call("get_image", { board: "b", id: "cat" }), { dataURL: "data:image/png;base64,AAAA" });
  assert.deepEqual(await second.call("get_image", { board: "b", id: "dog" }), {});
  await until(() => written.length === 3);
  assert.equal(written.at(-1), "/excalidraw-boards/b.json");
});

test("on its own, the board answers 2025 clients, and a page hears what the others change and where they point, but not its own", async (t) => {
  const { endpoint, board } = await start(t);
  const legacy = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1.0.0" } },
    }),
  });
  assert.match(await legacy.text(), /"protocolVersion":"2025-06-18"/);

  const changes = await board.ext.events.subscribe("board.changed", { board: "b", client: "me" });
  const presence = { name: "Ann", x: 1, y: 2, selected: [] };
  for (const [client, id] of [["me", "mine"], ["you", "yours"]] as const)
    await board.callTool({ name: "sync", arguments: { board: "b", client, elements: [element(id, 1)], presence } });
  const heard: unknown[] = [];
  for await (const { data } of changes) if (heard.push(data) === 2) break;
  assert.deepEqual(heard, [{ seq: 2, elements: [element("yours", 1)] }, { cursors: [{ id: "you", ...presence }] }]);
});

test("draw makes labelled boxes, text and the arrows between them, moves and erases them, and refuses what it cannot draw", async (t) => {
  const { call, elements, shapes } = await start(t);
  await call("draw", {
    board: "b",
    shapes: [
      { id: "link", type: "arrow", from: "api", to: "db", text: "SQL" },
      { id: "api", type: "rectangle", x: 0, y: 0, text: "API" },
      { id: "db", type: "ellipse", x: 400, y: 0, width: 120, height: 60, text: "DB", stroke: "dashed" },
      { id: "title", type: "text", x: 0, y: -100, text: "Hi", fontSize: 40 },
      { id: "note", type: "rectangle", x: 0, y: 200, text: "Hi", fontSize: 28 },
    ],
  });
  assert.deepEqual((await call("read_board", { board: "b" })).shapes, [
    { id: "api", type: "rectangle", x: 0, y: 0, width: 120, height: 65, text: "API" },
    { id: "db", type: "ellipse", x: 400, y: 0, width: 120, height: 60, text: "DB", stroke: "dashed" },
    { id: "title", type: "text", x: 0, y: -100, width: 34, height: 50, text: "Hi", fontSize: 40 },
    { id: "note", type: "rectangle", x: 0, y: 200, width: 120, height: 75, text: "Hi", fontSize: 28 },
    { id: "link", type: "arrow", x: 128, y: 32, width: 264, height: -2, text: "SQL", from: "api", to: "db" },
  ]);
  for (const id of ["api", "db"])
    assert.ok(
      ((await elements()).get(id)!.boundElements as { id: string }[]).some((bound) => bound.id === "link"),
      `${id} lists the arrow, so Excalidraw moves it along with the box`,
    );

  await call("draw", { board: "b", shapes: [{ id: "db", y: 400 }] });
  const moved = await shapes();
  assert.deepEqual([moved.db.x, moved.db.y, (await elements()).get("db")!.version], [400, 400, 2], "a change keeps what it leaves out");
  // An arrow's ends sit on the outlines of the shapes it joins, a gap of 8 away.
  const near = (x: number, y: number, { x: left, y: top, width, height }: { x: number; y: number; width: number; height: number }) =>
    x >= left - 9 && x <= left + width + 9 && y >= top - 9 && y <= top + height + 9;
  const { x, y, width, height } = moved.link;
  assert.ok(near(x, y, moved.api) && near(x + width, y + height, moved.db), "the arrow follows the box it points at");

  assert.deepEqual(await call("erase", { board: "b", ids: ["api", "missing"] }), { ids: ["api"] });
  assert.deepEqual(
    Object.values(await shapes()).map(({ id, from, to }) => ({ id, from, to })),
    [
      { id: "db", from: undefined, to: undefined },
      { id: "title", from: undefined, to: undefined },
      { id: "note", from: undefined, to: undefined },
      { id: "link", from: undefined, to: "db" },
    ],
  );
  assert.ok(
    ![...(await elements()).values()].some(({ containerId, isDeleted }) => containerId === "api" && !isDeleted),
    "its label goes with it",
  );

  const refused = (given: object[]) => call("draw", { board: "empty", shapes: given });
  await assert.rejects(refused([{ id: "a", x: 1 }]), /needs a type/);
  await assert.rejects(refused([{ type: "rectangle", id: "a" }, { type: "arrow", from: "a", to: "b" }]), /cannot attach to b/);
  await assert.rejects(refused([{ type: "frame", width: 500 }]), /wraps the shapes in it/);
  await assert.rejects(refused([{ id: "f", type: "frame" }]), /holds no shapes/);
});

test("shapes that come without a place are laid out along their arrows below what was there, and a frame wraps the shapes in it", async (t) => {
  const { call, elements, shapes } = await start(t);
  const draw = (given: object[], direction?: string) => call("draw", { board: "b", shapes: given, direction });
  const box = (id: string, frame?: string) => ({ id, type: "rectangle", ...(frame && { frame }) });
  await draw([{ ...box("old"), x: 0, y: 0 }]);
  await draw([{ id: "app", type: "frame", text: "App" }, box("a", "app"), box("b", "app"), { type: "arrow", from: "a", to: "b" }]);
  await draw([box("c"), box("d"), { type: "arrow", from: "c", to: "d" }], "down");
  const { old, app, a, b, c, d } = await shapes();
  assert.ok(a.y > old.y + old.height, "a call's shapes go below the board's");
  assert.ok(b.x > a.x + a.width && b.y === a.y, "arrows run right unless told otherwise");
  assert.ok(c.y > b.y + b.height, "the next call's go below those");
  assert.ok(d.y > c.y + c.height && d.x === c.x, "or down");
  assert.deepEqual(
    [app.text, app.x, app.y, app.x + app.width, app.y + app.height],
    ["App", a.x - 30, a.y - 30, b.x + b.width + 30, b.y + b.height + 30],
    "a frame wraps its shapes, 30 away",
  );

  await draw([{ id: "c", frame: "app" }]);
  const joined = await shapes();
  assert.equal(joined.app.y + joined.app.height, c.y + c.height + 30, "a shape that joins a frame later is wrapped too");
  const stacked = [...(await elements()).values()]
    .filter(({ containerId, isDeleted }) => !containerId && !isDeleted)
    .sort((one, other) => ((one.index as string) < (other.index as string) ? -1 : 1))
    .map(({ id }) => id);
  const at = stacked.indexOf("app");
  assert.deepEqual(new Set(stacked.slice(at - 3, at)), new Set(["a", "b", "c"]), "Excalidraw wants a frame's shapes right below it");

  await call("erase", { board: "b", ids: ["app"] });
  assert.deepEqual(
    Object.values(await shapes()).filter(({ type }) => type !== "arrow").map(({ id, frame }) => ({ id, frame })),
    ["old", "a", "b", "c", "d"].map((id) => ({ id, frame: undefined })),
    "the shapes in an erased frame stay",
  );
});
