import { createApps, ToolCallError, type Outputs } from "./chat-sdk/index.mjs";
import { mentionEditor, renderMentions } from "./mentions.ts";
import "./board-chat.css";

type Snapshot = Outputs["excalidraw-chat"]["read_board_chat"];

function select<T extends HTMLElement>(root: HTMLElement, query: string, type: { new(): T }) {
  const found = root.querySelector(query);
  if (!(found instanceof type)) throw new Error(`Missing chat element ${query}`);
  return found;
}

function signIn(board: string) {
  const next = new URL(location.pathname, location.origin);
  next.searchParams.set("board", board);
  const login = new URL("/.well-known/holon/login", location.origin);
  login.searchParams.set("resource", new URL("/mcp/excalidraw", location.origin).href);
  login.searchParams.set("returnTo", next.pathname + next.search);
  return login.href;
}

export function mountBoardChat(board: string, initiallyOpen: boolean, showElements: (ids: string[]) => void) {
  const { "excalidraw-chat": chat } = createApps({
    "excalidraw-chat": { endpoint: new URL("/mcp/excalidraw-chat", location.origin) },
  });
  const panel = document.createElement("aside");
  panel.className = "board-chat";
  panel.id = "board-chat";
  panel.setAttribute("aria-label", "Board chat");
  panel.innerHTML = `
    <header><div><strong>Board chat</strong><small>Anyone with the board link can read</small></div>
      <button type="button" data-close aria-label="Close chat">×</button></header>
    <div class="board-chat-thread"><p data-empty>Loading conversation…</p><ol role="log" aria-label="Room messages"></ol></div>
    <p class="board-chat-status" data-status role="status"></p>
    <div class="board-chat-footer">
      <div class="board-chat-guest" data-guest hidden><span>Sign in to post or ask the agent.</span><a data-signin>Sign in</a></div>
      <div data-composer hidden>
        <div class="board-chat-draft-wrap">
          <button type="button" class="board-chat-suggestion" data-suggestion hidden><strong>Agent</strong><span>@agent</span><kbd>↵</kbd></button>
          <div data-draft contenteditable="plaintext-only" role="textbox" aria-label="Message the room" aria-multiline="true" aria-autocomplete="list"></div>
        </div>
        <div class="board-chat-actions"><button type="button" data-mention>@agent</button><button type="button" data-send>Send</button></div>
      </div>
    </div>`;
  document.body.append(panel);
  const el = (query: string) => select(panel, query, HTMLElement);
  const btn = (query: string) => select(panel, query, HTMLButtonElement);
  const feed = el("ol");
  const thread = el(".board-chat-thread");
  const empty = el("[data-empty]");
  const status = el("[data-status]");
  const guest = el("[data-guest]");
  const composer = el("[data-composer]");
  const draft = el("[data-draft]");
  const sendButton = btn("[data-send]");
  select(panel, "[data-signin]", HTMLAnchorElement).href = signIn(board);

  let view: AbortController | undefined;
  let request = 0;
  let serial = "";
  let posting = false;
  let pendingTurn = false;
  let retry: { id: string; text: string } | undefined;
  const editor = mentionEditor(draft, btn("[data-suggestion]"), () => void send());

  function render(snapshot: Snapshot) {
    guest.hidden = snapshot.viewer !== null;
    composer.hidden = snapshot.viewer === null;
    pendingTurn = snapshot.pending;
    const next = JSON.stringify(snapshot.messages);
    if (next !== serial) {
      const scroll = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 38;
      const rows = snapshot.messages.map(({ author, kind, mine, text, elementIds }) => {
        const row = document.createElement("li");
        row.className = kind;
        const name = document.createElement("strong");
        name.textContent = kind === "human" && mine ? `${author} (you)` : author;
        const body = document.createElement("p");
        renderMentions(body, text);
        row.append(name, body);
        if (elementIds.length) {
          const focus = document.createElement("button");
          focus.type = "button";
          focus.textContent = "Show on board";
          focus.className = "board-chat-show";
          focus.addEventListener("click", () => {
            if (matchMedia("(max-width: 620px)").matches) open(false);
            showElements(elementIds);
          });
          row.append(focus);
        }
        return row;
      });
      feed.replaceChildren(...rows);
      if (scroll) thread.scrollTop = thread.scrollHeight;
      serial = next;
    }
    empty.textContent = "Start the conversation.";
    empty.hidden = snapshot.messages.length !== 0;
  }

  async function refresh(signal: AbortSignal) {
    const version = ++request;
    const snapshot = await chat.tools.read_board_chat({ board }, { signal, timeout: 8000 });
    if (!signal.aborted && version === request) render(snapshot);
  }

  async function poll(signal: AbortSignal) {
    try {
      await refresh(signal);
      if (status.dataset.connection) {
        delete status.dataset.connection;
        status.textContent = "";
      }
      if (pendingTurn && !status.textContent) status.textContent = "Agent is working…";
      else if (!pendingTurn && status.textContent === "Agent is working…") status.textContent = "";
    } catch {
      if (!signal.aborted && !status.textContent) {
        status.dataset.connection = "error";
        status.textContent = "Chat is unavailable. Reconnecting…";
        empty.hidden = true;
      }
    }
    if (!signal.aborted) setTimeout(() => { if (!signal.aborted) void poll(signal); }, document.hidden ? 8000 : 1600);
  }

  async function send() {
    const text = editor.current().trim();
    if (posting || !view || composer.hidden || !text) return;
    const signal = view.signal;
    retry = retry?.text === text ? retry : { id: crypto.randomUUID(), text };
    posting = true;
    sendButton.disabled = true;
    status.textContent = "";
    try {
      await chat.tools.send_board_message({ board, ...retry }, { signal, timeout: 8000 });
      retry = undefined;
      if (editor.current().trim() === text) editor.clear();
      void refresh(signal).catch(() => {});
    } catch (error) {
      if (!signal.aborted) status.textContent = error instanceof ToolCallError
        ? error.text ?? "Couldn’t send the message." : "Couldn’t send the message. Try again.";
    } finally {
      posting = false;
      sendButton.disabled = false;
    }
  }

  function open(value: boolean) {
    view?.abort();
    panel.hidden = !value;
    document.querySelector("[aria-controls=board-chat]")?.setAttribute("aria-expanded", String(value));
    view = value ? new AbortController() : undefined;
    if (view) void poll(view.signal);
  }

  panel.addEventListener("keydown", (event) => { if (event.key !== "Escape") event.stopPropagation(); });
  btn("[data-close]").addEventListener("click", () => {
    open(false);
    document.querySelector<HTMLElement>("[aria-controls=board-chat]")?.focus();
  });
  btn("[data-mention]").addEventListener("click", editor.mention);
  sendButton.addEventListener("click", () => void send());
  addEventListener("pagehide", () => view?.abort(), { once: true });
  open(initiallyOpen);
  return () => open(panel.hidden === true);
}
