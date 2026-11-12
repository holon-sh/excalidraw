import { z } from "zod";
import type { Store } from "./store.ts";
import { type Element, element } from "./tools.ts";

/** A board as it is kept between restarts, as the JSON object `<board>.json`. */
const saved = z.object({ seq: z.number().int().nonnegative(), elements: z.array(element) });

type Board = {
  /** Counts the elements stored so far, so a page can ask for what came after. */
  seq: number;
  elements: Map<string, { element: Element; seq: number }>;
  /** When a call last used the board. */
  used: number;
  /** The save to come, while the board has changes the store lacks. */
  saving?: ReturnType<typeof setTimeout>;
};

const MAX_ELEMENTS = 5000;
/** A burst of edits is saved once, this long after its first one. */
const SAVE_AFTER = 2000;
/** An unused board stays in memory this long. The store still has it afterwards. */
const KEEP = 10 * 60_000;
/** An erased element is saved this long, for pages that have yet to hear of the erasure. */
const KEEP_ERASED = 24 * 60 * 60_000;

/** Every board's elements: in memory while in use, and in the store. */
export class Boards {
  /** When this memory began. A page that sees it change sends its board again. */
  readonly epoch = Date.now();
  private readonly store: Store;
  private readonly boards = new Map<string, Board>();
  private readonly loading = new Map<string, Promise<Board>>();

  constructor(store: Store) {
    this.store = store;
  }

  /** The board's elements, erased ones included. */
  async elements(id: string): Promise<Map<string, Element>> {
    const board = await this.open(id);
    return new Map([...board.elements].map(([key, { element }]) => [key, element]));
  }

  /**
   * Stores each element that wins over the board's copy, by Excalidraw's own
   * rule: the higher version, and at equal versions the lower nonce. Returns
   * the elements stored, with the board's count after them.
   */
  async merge(id: string, incoming: Element[]): Promise<{ seq: number; elements: Element[] }> {
    const board = await this.open(id);
    const stored = incoming.filter((element) => {
      const current = board.elements.get(element.id)?.element;
      return (
        !current ||
        element.version > current.version ||
        (element.version === current.version &&
          element.versionNonce < current.versionNonce)
      );
    });
    const added = stored.filter(({ id }) => !board.elements.has(id)).length;
    if (board.elements.size + added > MAX_ELEMENTS)
      throw new Error(`A board holds at most ${MAX_ELEMENTS} elements.`);
    for (const element of stored)
      board.elements.set(element.id, { element, seq: ++board.seq });
    if (stored.length) this.save(id, board);
    return { seq: board.seq, elements: stored };
  }

  /** The elements stored after `since`, with the board's current count. */
  async since(id: string, since: number): Promise<{ seq: number; elements: Element[] }> {
    const board = await this.open(id);
    return {
      seq: board.seq,
      elements: [...board.elements.values()]
        .filter((entry) => entry.seq > since)
        .map(({ element }) => element),
    };
  }

  /** The board in memory, read from the store when it is not there. */
  private async open(id: string): Promise<Board> {
    const now = Date.now();
    for (const [other, { saving, used }] of this.boards)
      if (!saving && now - used > KEEP) this.boards.delete(other);
    const board = this.boards.get(id) ?? (await this.load(id));
    board.used = now;
    return board;
  }

  /** Reads a board once, however many calls are waiting for it. */
  private load(id: string): Promise<Board> {
    let loading = this.loading.get(id);
    if (!loading) {
      loading = this.store
        .read(`${id}.json`)
        .then((json) => {
          const kept = json === undefined ? undefined : saved.parse(JSON.parse(json));
          // A page cannot tell which of these it has, so each counts as the latest.
          const seq = kept?.seq ?? 0;
          const elements = kept?.elements.map((element) => [element.id, { element, seq }] as const);
          const board = { seq, elements: new Map(elements), used: Date.now() };
          this.boards.set(id, board);
          return board;
        })
        .finally(() => this.loading.delete(id));
      this.loading.set(id, loading);
    }
    return loading;
  }

  /** Saves a changed board shortly, and tries again if the store refuses. */
  private save(id: string, board: Board) {
    board.saving ??= setTimeout(() => {
      board.saving = undefined;
      const fresh = Date.now() - KEEP_ERASED;
      const elements = [...board.elements.values()]
        .map(({ element }) => element)
        .filter((element) => !element.isDeleted || (element.updated ?? 0) > fresh);
      this.store.write(`${id}.json`, JSON.stringify({ seq: board.seq, elements } satisfies z.infer<typeof saved>)).catch((error) => {
        console.error(error);
        this.save(id, board);
      });
    }, SAVE_AFTER);
  }
}
