import {
  CaptureUpdateAction,
  Excalidraw,
  Footer,
  LiveCollaborationTrigger,
  MainMenu,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { ExcalidrawElement, Theme } from "@excalidraw/excalidraw/element/types";
import type {
  BinaryFileData,
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";
import { createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connect, type Outputs } from "#holon-ui";
import type { Change } from "../src/tools.ts";
import "./styles.css";

const lifetime = new AbortController();
const status = document.querySelector<HTMLElement>("#status")!;
// The build picks the surface. Inside an MCP Apps host the page calls its
// server through the host. On its own it calls the endpoint, where a call can
// stay open and stream.
const app = await connect();
// The board takes its embedded height before Excalidraw measures it, which a
// page in a background tab may not do again before it fits the board.
if (app.view) document.documentElement.classList.add("mcp-app");

/** Names this page to the server and to the other pages. */
const client = crypto.randomUUID().slice(0, 8);
const name = `Guest ${Math.floor(100 + Math.random() * 900)}`;
let board: string;
/** The board's page, which anyone with the link can open and draw on. */
let address: string | undefined;
/** Names the server's memory, which starts empty when the server restarts. */
let epoch: number | undefined;
/** The server's count of the board's changes that this page has seen. */
let since = 0;
/** The version of each element that the server is known to have. */
const known = new Map<string, number>();
/** The images whose files the server has: the ones this page stored there or read from it. */
const stored = new Set<string>();
/** The images this page is storing or reading, and the ones whose files the server lacks. */
const busy = new Set<string>();
/** The longest data URL the server stores: 1.5 MB of image. Holon takes requests of up to 4 MiB, and one near that has taken the app down. */
const LONGEST_IMAGE = 2_000_000;
/** How often storing or reading each image has failed, to try it less and less often. */
const failed = new Map<string, number>();
/** Everyone else on the board. */
const others = new Map<SocketId, Collaborator>();
/** Where this page's pointer is on the board, once it has moved. */
let pointer: { x: number; y: number } | undefined;
/** The pointer and selection the server was last told, as JSON. */
let told: string | undefined;
/** Whether the page may lack changes others made, so that its next call asks for them. */
let behind = false;

/** A link that opens in a new tab, or through the MCP Apps host, whose frame may not open tabs. */
const link = (url: string, text: string) =>
  createElement(
    "a",
    {
      href: url,
      target: "_blank",
      rel: "noopener",
      onClick: (event) => {
        if (!app.view?.getHostCapabilities()?.openLinks) return;
        event.preventDefault();
        app.view.openLink({ url }).catch(console.warn);
      },
    },
    text,
  );

type Choice = Theme | "system";
const dark = matchMedia("(prefers-color-scheme: dark)");
const themeOf = (choice: Choice): Theme =>
  choice === "system" ? (dark.matches ? "dark" : "light") : choice;

/** The theme this browser last chose. A page in a frame may not have storage, and follows the system. */
function chosen(): Choice {
  try {
    const choice = localStorage.getItem("theme");
    if (choice === "light" || choice === "dark") return choice;
  } catch {}
  return "system";
}

/** Excalidraw's own menu, whose theme item also offers the system's theme. */
function Menu() {
  const [choice, choose] = useState(chosen);
  useEffect(() => {
    try {
      localStorage.setItem("theme", choice);
    } catch {}
    const show = () => excalidraw.updateScene({ appState: { theme: themeOf(choice) } });
    show();
    dark.addEventListener("change", show);
    // Excalidraw's shortcut changes the theme without the menu.
    const off = excalidraw.onChange((_, { theme }) => {
      if (theme !== themeOf(choice)) choose(theme);
    });
    return () => {
      dark.removeEventListener("change", show);
      off();
    };
  }, [choice]);
  const { DefaultItems, Group, Separator } = MainMenu;
  return createElement(
    MainMenu,
    null,
    createElement(DefaultItems.LoadScene),
    createElement(DefaultItems.SaveToActiveFile),
    createElement(DefaultItems.Export),
    createElement(DefaultItems.SaveAsImage),
    createElement(DefaultItems.SearchMenu),
    createElement(DefaultItems.Help),
    createElement(DefaultItems.ClearCanvas),
    createElement(Separator),
    createElement(Group, {
      title: "Excalidraw links",
      children: createElement(DefaultItems.Socials),
    }),
    createElement(Separator),
    createElement(DefaultItems.ToggleTheme, { allowSystemTheme: true, theme: choice, onSelect: choose }),
    createElement(DefaultItems.ChangeCanvasBackground),
  );
}

/** Copies the board's link, and says how agents join. A frame that may not use the clipboard shows the link instead. */
async function share() {
  if (!address) return;
  const agents = new URL("/mcp/excalidraw", address).href;
  try {
    await navigator.clipboard.writeText(address);
    excalidraw.setToast({ message: `Link copied. Anyone with it can draw here, and agents join at ${agents}`, closable: true, duration: 8000 });
  } catch {
    excalidraw.setToast({ message: `Share ${address}. Agents join at ${agents}`, closable: true, duration: 15_000 });
  }
}

/** Excalidraw's API, from the moment Excalidraw starts. */
let excalidraw!: ExcalidrawImperativeAPI;
await new Promise<void>((loaded) => {
  createRoot(document.querySelector("#board")!).render(
    createElement(
      Excalidraw,
      {
        excalidrawAPI: (api) => (excalidraw = api),
        initialData: { appState: { theme: themeOf(chosen()) } },
        isCollaborating: true,
        // Excalidraw reports its first change when it has finished loading, which
        // empties the scene. From then on the scene is the page's to fill.
        onChange: () => {
          loaded();
          images();
          send();
          if (unfitted) fit();
        },
        onPointerUpdate: ({ pointer: { x, y } }) => {
          pointer = { x, y };
          send();
        },
        renderTopRightUI: () => createElement(LiveCollaborationTrigger, { isCollaborating: true, onSelect: share }),
      },
      createElement(Menu),
      createElement(
        Footer,
        null,
        createElement(
          "p",
          { className: "credit" },
          "Built with ",
          link("https://github.com/excalidraw/excalidraw", "Excalidraw"),
          " on ",
          link("https://github.com/holon-sh", "Holon"),
        ),
      ),
    ),
  );
});

/** The elements the server lacks. An image waits for the server to have its file, so that nobody is sent one they cannot draw. */
function edited() {
  const files = excalidraw.getFiles();
  return excalidraw.getSceneElementsIncludingDeleted().filter(
    (element) =>
      known.get(element.id) !== element.version &&
      !(
        element.type === "image" &&
        !element.isDeleted &&
        (!element.fileId || (files[element.fileId] && !stored.has(element.fileId)))
      ),
  );
}

/** Stores the file of each image this page added, and reads the file of each image others added. */
function images() {
  if (!board) return;
  const files = excalidraw.getFiles();
  for (const element of excalidraw.getSceneElements()) {
    if (element.type !== "image" || !element.fileId) continue;
    const id = element.fileId;
    if (stored.has(id) || busy.has(id)) continue;
    busy.add(id);
    const file = files[id];
    if (file && file.dataURL.length > LONGEST_IMAGE) {
      // It stays busy, and its element stays on this page only.
      excalidraw.setToast({
        message: "This image is too large to share. Only you can see it. Images of up to 1.5 MB are shared.",
        closable: true,
        duration: 10_000,
      });
      continue;
    }
    const moved = file
      ? app.tools
          .put_image({ board, id, dataURL: file.dataURL }, { signal: lifetime.signal })
          .then(() => true)
      : app.tools.get_image({ board, id }, { signal: lifetime.signal }).then(({ dataURL }) => {
          if (!dataURL) return false;
          const mimeType = dataURL.slice("data:".length, dataURL.indexOf(";"));
          excalidraw.addFiles([{ id, dataURL, mimeType, created: Date.now() } as BinaryFileData]);
          return true;
        });
    moved.then(
      (here) => {
        // A file the server lacks stays busy, to be asked for again once the server restarts.
        if (!here) return;
        stored.add(id);
        busy.delete(id);
        send();
      },
      (error) => {
        const tries = (failed.get(id) ?? 0) + 1;
        failed.set(id, tries);
        const again = () => {
          busy.delete(id);
          images();
        };
        retry(error, again, Math.min(60_000, 1000 * 2 ** tries));
      },
    );
  }
}

const presence = () =>
  pointer && {
    name,
    ...pointer,
    selected: Object.keys(excalidraw.getAppState().selectedElementIds).slice(0, 200),
  };

/** Draws what others changed, and where they are. */
function apply({ epoch: memory, seq, elements = [], cursors = [], gone = [] }: Change & { epoch?: number }) {
  if (memory !== undefined) {
    const restarted = epoch !== undefined && epoch !== memory;
    epoch = memory;
    if (restarted) {
      // The server lost the board, so this page sends all of it and reads it again.
      known.clear();
      stored.clear();
      busy.clear();
      since = 0;
      images();
      return read();
    }
  }
  const blank = !excalidraw.getSceneElements().length;
  for (const { id, version } of elements) known.set(id, version);
  if (elements.length)
    excalidraw.updateScene({
      elements: reconcileElements(
        excalidraw.getSceneElementsIncludingDeleted(),
        // The contract types only the fields a merge reads. The rest is Excalidraw's.
        restoreElements(elements as unknown as ExcalidrawElement[], null) as RemoteExcalidrawElement[],
        excalidraw.getAppState(),
      ),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  // A page that showed nothing brings what others drew into view, as when an agent draws on a new board.
  if (blank && excalidraw.getSceneElements().length) fit();
  for (const { id, name, x, y, selected } of cursors)
    others.set(id as SocketId, {
      username: name,
      pointer: { x, y, tool: "pointer" },
      selectedElementIds: Object.fromEntries(selected.map((id) => [id, true])),
    });
  for (const id of gone) others.delete(id as SocketId);
  if (cursors.length || gone.length) excalidraw.updateScene({ collaborators: new Map(others) });
  if (seq !== undefined) since = seq;
}

/** Whether the board's content has yet to be brought into view. */
let unfitted = false;

/** Shows the whole board, once the page has a size to fit it in. */
function fit() {
  const { width, height } = excalidraw.getAppState();
  // A page that is not showing has no size. Its next change tries again.
  unfitted = !width || !height;
  if (!unfitted)
    excalidraw.scrollToContent(undefined, {
      fitToViewport: true,
      viewportZoomFactor: 0.8,
      maxZoom: 1,
    });
}

/** Says that the board is not syncing, and tries again shortly. */
function retry(error: unknown, run: () => void, wait = 2000) {
  if (lifetime.signal.aborted) return;
  status.textContent = "Not synced. Trying again.";
  console.warn(error);
  setTimeout(run, wait);
}

/** Whether a call to sync is under way. The next waits for it, and carries everything that changed meanwhile. */
let sending = false;

/** Asks the server for what others changed since this page last heard. */
function read() {
  behind = true;
  send();
}

/** Tells the server this page's edits and pointer. A page that may be behind also asks for what others changed. */
function send() {
  if (!board || sending) return;
  const elements = edited();
  const mine = presence();
  const poll = behind;
  if (!elements.length && JSON.stringify(mine) === told && !poll) return;
  behind = false;
  for (const { id, version } of elements) known.set(id, version);
  told = JSON.stringify(mine);
  sending = true;
  app.tools
    .sync(
      { board, client, elements, presence: mine, ...(poll && { since }) },
      { signal: lifetime.signal },
    )
    .then((reply) => {
      status.textContent = "";
      if (!poll) return apply({ epoch: reply.epoch });
      // A reply names everyone else on the board, so whoever it leaves out has left.
      const gone = [...others.keys()].filter((id) => !reply.cursors.some((cursor) => cursor.id === id));
      apply({ ...reply, gone });
    })
    .then(
      () => {
        sending = false;
        send();
      },
      (error) => {
        for (const { id } of elements) known.delete(id);
        behind ||= poll;
        told = undefined;
        retry(error, () => {
          sending = false;
          send();
        });
      },
    );
}

if (app.view) {
  app.view.onteardown = async () => {
    lifetime.abort();
    return {};
  };
  // read_board is the one tool that opens the board. A host that does not say
  // which tool it was delivers the result as it came.
  app.opened?.then((opened) => {
    ({ board, url: address } =
      opened.tool === "read_board"
        ? opened.output
        : (opened.output as { structuredContent: Outputs["excalidraw"]["read_board"] }).structuredContent);
    read();
  }, console.warn);
  // A host relays tool calls and nothing else, so the embedded board asks instead of subscribing.
  const poll = setInterval(read, 1000);
  lifetime.signal.addEventListener("abort", () => clearInterval(poll));
} else {
  const url = new URL(location.href);
  board = url.searchParams.get("board") ?? crypto.randomUUID().slice(0, 8);
  url.searchParams.set("board", board);
  history.replaceState(null, "", url);
  address = url.href;
  const { events } = app.ext;
  /**
   * Subscribes to the board's changes, and reads the board as it stands: now,
   * and whenever the server says it skipped some.
   */
  const follow = () => {
    events
      .subscribe("board.changed", { board, client }, { signal: lifetime.signal, onGap: read })
      .then(async (changes) => {
        read();
        for await (const { data } of changes) apply(data);
      })
      .catch((error) => retry(error, follow));
  };
  follow();
}
