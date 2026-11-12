import { randomUUID } from "node:crypto";
import dagre from "@dagrejs/dagre";
import { generateKeyBetween } from "fractional-indexing";
import type { z } from "zod";
import type { Element, tools } from "./tools.ts";

type Draw = z.infer<typeof tools.draw.inputSchema>;
/** What an agent draws: a box, some text, an arrow between two shapes, or a frame around shapes. */
type Shape = Draw["shapes"][number] & { id: string };
/** A board element as an agent reads it. An arrow's width and height run from its start to its end. */
type Seen = z.infer<typeof tools.read_board.outputSchema>["shapes"][number];

type Point = [number, number];
type Binding = { elementId: string; focus: number; gap: number } | null;

/** The fields of an Excalidraw element that drawing reads and writes. */
type Drawn = Element & {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  strokeStyle: string;
  index: string | null;
  frameId: string | null;
  boundElements: { id: string; type: string }[] | null;
  name?: string | null;
  fontSize?: number;
  originalText?: string;
  containerId?: string | null;
  points?: Point[];
  startBinding?: Binding;
  endBinding?: Binding;
};

const STROKE = "#1e1e1e";
/** How Excalidraw draws a frame, which ignores the frame's own colors. */
const FRAME = { strokeColor: "#bbb", roughness: 0, name: null };
const FONT_SIZE = 20;
const LINE_HEIGHT = 1.25;
// Excalidraw measures text on a canvas, and the server has none. These are the
// widths of Excalifont's ASCII characters at the default font size, in pixels
// rounded up, as a canvas in the page measured them. Any other character counts
// as wide, and other sizes scale.
const WIDTHS: Record<number, string> = {
  5: "'il",
  6: ",.:;|",
  7: "!",
  8: ' "/',
  9: "()-1\\fjr",
  10: "?[]",
  11: "*+<=>IL^ceknpqsuy{}",
  12: "47HJVY`abghotvxz",
  13: "35689CKNSXd",
  14: "02AFP_m~",
  15: "$&ERUw",
  16: "#BDGMOQW",
  17: "@Z",
  18: "T",
  19: "%",
};
const WIDE = 22;
const WIDTH = new Map(
  Object.entries(WIDTHS).flatMap(([width, characters]) =>
    [...characters].map((character): [string, number] => [character, Number(width)]),
  ),
);
const span = (line: string, fontSize: number) =>
  ([...line].reduce((sum, character) => sum + (WIDTH.get(character) ?? WIDE), 0) * fontSize) /
  FONT_SIZE;
/** The space between an arrow's end and the shape it points at. */
const GAP = 8;
/** The space between a frame's edge and the shapes in it. */
const PADDING = 30;
/** The space between the shapes the board places and what was on the board already. */
const MARGIN = 100;
/** The share of a box's width that its label may fill. */
const LABEL_SHARE: Record<string, number> = {
  rectangle: 1,
  ellipse: 0.7,
  diamond: 0.5,
};

const random = () => Math.floor(Math.random() * 2 ** 31);
const name = () => randomUUID().slice(0, 8);

const blank = (type: string) => ({
  type,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  angle: 0,
  strokeColor: STROKE,
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness:
    type === "rectangle"
      ? { type: 3 }
      : type === "diamond" || type === "arrow"
        ? { type: 2 }
        : null,
  seed: random(),
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  link: null,
  locked: false,
  ...(type === "frame" && FRAME),
});

/** One call's changes to a board, each element one version past the board's copy. */
class Draft {
  readonly changed = new Map<string, Drawn>();
  readonly stored: Map<string, Drawn>;

  // Every element on a board is whole: a page restores what it sends, and this module writes the rest.
  constructor(stored: Map<string, Element>) {
    this.stored = stored as Map<string, Drawn>;
  }

  /** The elements this call leaves on the board. */
  elements(): Drawn[] {
    const all = new Map([...this.stored, ...this.changed]).values();
    return [...all].filter((element) => !element.isDeleted);
  }

  /** The element as this call leaves it, unless it is erased or was never drawn. */
  get(id: string | null | undefined): Drawn | undefined {
    if (!id) return undefined;
    const element = this.changed.get(id) ?? this.stored.get(id);
    return element?.isDeleted ? undefined : element;
  }

  /**
   * Changes an element, or starts one of `type` on top of the others. An
   * element that joins a frame goes right below it, where Excalidraw keeps a
   * frame's shapes.
   */
  set(id: string, fields: Partial<Drawn>, type?: string): Drawn {
    const previous = this.get(id);
    const next = {
      ...(previous ?? blank(type!)),
      ...fields,
      id,
      version: (this.stored.get(id)?.version ?? 0) + 1,
      versionNonce: random(),
      updated: Date.now(),
    } as Drawn;
    if (!previous || (next.frameId && next.frameId !== previous.frameId)) {
      const ceiling = this.get(next.frameId)?.index ?? null;
      let floor: string | null = null;
      // An index this call has since changed can only raise the floor, which is harmless.
      for (const elements of [this.stored, this.changed])
        for (const { index } of elements.values())
          if (typeof index === "string" && (!ceiling || index < ceiling) && (!floor || index > floor))
            floor = index;
      next.index = generateKeyBetween(floor, ceiling);
    }
    this.changed.set(id, next);
    return next;
  }
}

function size(text: string, fontSize: number) {
  const lines = text.split("\n");
  return {
    width: Math.max(...lines.map((line) => span(line, fontSize))),
    height: lines.length * fontSize * LINE_HEIGHT,
  };
}

/** Breaks lines at spaces so that each fits `width`, as far as its words allow. */
function wrap(text: string, width: number, fontSize: number): string {
  return text
    .split("\n")
    .flatMap((line) =>
      line.split(" ").reduce<string[]>((lines, word) => {
        const last = lines.at(-1);
        if (last !== undefined && span(`${last} ${word}`, fontSize) <= width)
          lines[lines.length - 1] = `${last} ${word}`;
        else lines.push(word);
        return lines;
      }, []),
    )
    .join("\n");
}

/** Where a label sits: a box's center, or the middle point of an arrow. */
function middle(element: Drawn): Point {
  const point = element.points?.[Math.floor(element.points.length / 2)];
  if (!point)
    return [element.x + element.width / 2, element.y + element.height / 2];
  const [x, y] = element.points!.length === 2 ? [point[0] / 2, point[1] / 2] : point;
  return [element.x + x, element.y + y];
}

/** The point on a shape's outline that faces `toward`, set off by the gap. */
function edge(shape: Drawn, [x, y]: Point): Point {
  const [centerX, centerY] = middle(shape);
  const [dx, dy] = [x - centerX, y - centerY];
  const length = Math.hypot(dx, dy);
  if (!length) return [centerX, centerY];
  const [halfWidth, halfHeight] = [shape.width / 2, shape.height / 2];
  // The outline's distance from the center, as a share of the way to `toward`.
  const reach =
    shape.type === "ellipse"
      ? 1 / Math.hypot(dx / halfWidth, dy / halfHeight)
      : shape.type === "diamond"
        ? 1 / (Math.abs(dx) / halfWidth + Math.abs(dy) / halfHeight)
        : Math.min(halfWidth / Math.abs(dx), halfHeight / Math.abs(dy));
  const share = reach + GAP / length;
  return [centerX + dx * share, centerY + dy * share];
}

/**
 * Centers `text` on a box or an arrow as its label, or re-centers the label it
 * has when no text is given. An empty text removes the label.
 */
function label(draft: Draft, container: Drawn, text?: string, fontSize?: number) {
  const bound = container.boundElements?.find(({ type }) => type === "text");
  const previous = draft.get(bound?.id);
  const original = text ?? previous?.originalText;
  if (original === undefined) return;
  if (!original) {
    if (!bound) return;
    draft.set(bound.id, { isDeleted: true });
    draft.set(container.id, {
      boundElements: container.boundElements!.filter((other) => other !== bound),
    });
    return;
  }
  const share = LABEL_SHARE[container.type];
  const points = fontSize ?? previous?.fontSize ?? FONT_SIZE;
  const wrapped = share ? wrap(original, container.width * share - 20, points) : original;
  const { width, height } = size(wrapped, points);
  const id = bound?.id ?? name();
  const holder = draft.set(container.id, {
    ...(share && { height: Math.max(container.height, height + 20) }),
    ...(!bound && {
      boundElements: [...(container.boundElements ?? []), { id, type: "text" }],
    }),
  });
  const [x, y] = middle(holder);
  draft.set(
    id,
    {
      ...written(wrapped, original, points),
      containerId: container.id,
      frameId: holder.frameId,
      textAlign: "center",
      verticalAlign: "middle",
      x: x - width / 2,
      y: y - height / 2,
    },
    "text",
  );
}

/** The fields of a text element showing `text`, which read `original` before it was wrapped. */
function written(text: string, original: string, fontSize: number) {
  return {
    ...size(text, fontSize),
    text,
    originalText: original,
    fontSize,
    fontFamily: 5,
    lineHeight: LINE_HEIGHT,
    autoResize: true,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
  };
}

/** Moves an arrow's bound ends onto the outlines of the shapes it joins. */
function route(draft: Draft, id: string, text?: string, fontSize?: number) {
  const arrow = draft.get(id);
  if (!arrow?.points) return;
  const points = arrow.points.map(([x, y]): Point => [arrow.x + x, arrow.y + y]);
  const [start, end] = [
    draft.get(arrow.startBinding?.elementId),
    draft.get(arrow.endBinding?.elementId),
  ];
  // A straight arrow between two shapes aims at their centers; a bent one
  // keeps its bends and aims at the nearest of them.
  const straight = points.length === 2 && start && end;
  if (start) points[0] = edge(start, straight ? middle(end!) : points[1]!);
  if (end) points[points.length - 1] = edge(end, straight ? middle(start!) : points.at(-2)!);
  const [x, y] = points[0]!;
  const relative = points.map(([pointX, pointY]): Point => [pointX - x, pointY - y]);
  const [xs, ys] = [relative.map((point) => point[0]), relative.map((point) => point[1])];
  const moved = draft.set(id, {
    x,
    y,
    points: relative,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  });
  label(draft, moved, text, fontSize);
}

/** The type a shape has or is to have, refusing a change of type. */
function kind(shape: Shape, previous?: Drawn): string {
  if (!previous) {
    if (!shape.type) throw new Error(`Shape ${shape.id} is new, so it needs a type.`);
    return shape.type;
  }
  if (shape.type && shape.type !== previous.type)
    throw new Error(
      `Shape ${shape.id} is a ${previous.type}. Erase it to draw a ${shape.type} with that id.`,
    );
  return previous.type;
}

/** The fields that every type of shape takes alike. */
function look(draft: Draft, { id, color, fill, stroke, frame }: Shape) {
  if (frame && draft.get(frame)?.type !== "frame")
    throw new Error(`Shape ${id} cannot sit in ${frame}, which is not a frame on the board.`);
  return {
    ...(color && { strokeColor: color }),
    ...(fill && { backgroundColor: fill }),
    ...(stroke && { strokeStyle: stroke }),
    ...(frame !== undefined && { frameId: frame || null }),
  };
}

function place(draft: Draft, shape: Shape) {
  const previous = draft.get(shape.id);
  const type = kind(shape, previous);
  const at = { x: shape.x ?? previous?.x ?? 0, y: shape.y ?? previous?.y ?? 0 };
  if (type === "frame") {
    if ((shape.x ?? shape.y ?? shape.width ?? shape.height ?? shape.frame) !== undefined)
      throw new Error(`Frame ${shape.id} wraps the shapes in it, so it takes no x, y, width, height or frame.`);
    draft.set(shape.id, shape.text === undefined ? {} : { name: shape.text || null }, type);
    return;
  }
  const fontSize = shape.fontSize ?? previous?.fontSize ?? FONT_SIZE;
  if (type === "text") {
    const text = shape.text ?? previous?.originalText;
    if (!text) throw new Error(`Text ${shape.id} needs text.`);
    draft.set(shape.id, { ...written(text, text, fontSize), ...at, ...look(draft, shape) }, type);
  } else if (type in LABEL_SHARE) {
    const fit = size(shape.text ?? "", fontSize);
    const box = draft.set(
      shape.id,
      {
        ...at,
        ...look(draft, shape),
        width: shape.width ?? previous?.width ?? Math.max(120, fit.width / LABEL_SHARE[type]! + 40),
        height: shape.height ?? previous?.height ?? Math.max(60, fit.height + 40),
      },
      type,
    );
    label(draft, box, shape.text, shape.fontSize);
  } else throw new Error(`Shape ${shape.id} is a ${type}, which draw cannot change.`);
  for (const bound of draft.get(shape.id)!.boundElements ?? [])
    if (bound.type === "arrow") route(draft, bound.id);
}

function connect(draft: Draft, shape: Shape) {
  const previous = draft.get(shape.id);
  kind(shape, previous);
  const ends = {
    startBinding: shape.from ?? previous?.startBinding?.elementId,
    endBinding: shape.to ?? previous?.endBinding?.elementId,
  };
  if (!previous && !(ends.startBinding && ends.endBinding))
    throw new Error(`Arrow ${shape.id} is new, so it needs from and to.`);
  if (ends.startBinding && ends.startBinding === ends.endBinding)
    throw new Error(`Arrow ${shape.id} needs two different shapes.`);
  const joined = Object.values(ends).filter((id) => id !== undefined);
  for (const id of joined)
    if (!draft.get(id) || draft.get(id)!.points || draft.get(id)!.type === "frame")
      throw new Error(`Arrow ${shape.id} cannot attach to ${id}, which is not a shape on the board.`);
  for (const left of [previous?.startBinding, previous?.endBinding])
    if (left && !joined.includes(left.elementId) && draft.get(left.elementId))
      draft.set(left.elementId, {
        boundElements: draft
          .get(left.elementId)!
          .boundElements!.filter((bound) => bound.id !== shape.id),
      });
  draft.set(
    shape.id,
    {
      ...(!previous && {
        points: [
          [0, 0],
          [0, 0],
        ],
        lastCommittedPoint: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      }),
      ...look(draft, shape),
      ...Object.fromEntries(
        Object.entries(ends).map(([side, id]) => [
          side,
          id ? { elementId: id, focus: 0, gap: GAP } : null,
        ]),
      ),
    },
    "arrow",
  );
  for (const id of joined) {
    const bound = draft.get(id)!.boundElements ?? [];
    if (!bound.some((other) => other.id === shape.id))
      draft.set(id, { boundElements: [...bound, { id: shape.id, type: "arrow" }] });
  }
  route(draft, shape.id, shape.text, shape.fontSize);
}

/** The box around elements, an arrow's by its points. */
function bounds(elements: Drawn[]) {
  const corners = elements.flatMap(({ x, y, width, height, points }) =>
    (points ?? [[0, 0], [width, height]]).map(([dx, dy]) => [x + dx, y + dy]),
  );
  const [xs, ys] = [corners.map(([x]) => x!), corners.map(([, y]) => y!)];
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/**
 * Places the new shapes that came without x and y: in layers along the arrows
 * between them, as Mermaid lays out a flowchart, with each frame's shapes
 * together, and below what was on the board already.
 */
function layout(draft: Draft, loose: Shape[], arrows: Shape[], direction: Draw["direction"]) {
  if (!loose.length) return;
  const ids = new Set(loose.map(({ id }) => id));
  const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  graph.setGraph({ rankdir: direction === "down" ? "TB" : "LR", nodesep: 60, ranksep: 100 });
  for (const { id } of loose) {
    const { width, height, frameId } = draft.get(id)!;
    graph.setNode(id, { width, height });
    if (frameId) graph.setNode(frameId, {}).setParent(id, frameId);
  }
  for (const { id, from, to, text, fontSize } of arrows)
    if (ids.has(from!) && ids.has(to!))
      graph.setEdge(from!, to!, text ? size(text, fontSize ?? FONT_SIZE) : {}, id);
  dagre.layout(graph);
  const boxes = loose.map(({ id }) => {
    const { x, y, width, height } = graph.node(id);
    return { id, x: x! - width / 2, y: y! - height / 2 };
  });
  const block = { left: Math.min(...boxes.map(({ x }) => x)), top: Math.min(...boxes.map(({ y }) => y)) };
  // Frames follow their shapes, so only the shapes count as what was there.
  const there = draft
    .elements()
    .filter(({ id, containerId, type }) => !ids.has(id) && !ids.has(containerId!) && type !== "frame");
  const at = there.length ? bounds(there) : undefined;
  const [dx, dy] = at ? [at.left - block.left, at.bottom + MARGIN - block.top] : [-block.left, -block.top];
  for (const { id, x, y } of boxes) place(draft, { id, x: Math.round(x + dx), y: Math.round(y + dy) });
}

/** Wraps each frame whose shapes this call changed around the shapes it holds. */
function enclose(draft: Draft) {
  const frames = new Set<string>();
  for (const element of draft.changed.values())
    for (const id of [
      element.type === "frame" ? element.id : element.frameId,
      draft.stored.get(element.id)?.frameId,
    ])
      if (id) frames.add(id);
  for (const id of frames) {
    const frame = draft.get(id);
    if (!frame) continue;
    const inside = draft.elements().filter(({ frameId }) => frameId === id);
    if (!inside.length) {
      if (!frame.width) throw new Error(`Frame ${id} holds no shapes. Give the shapes in it frame ${id}.`);
      continue;
    }
    const { left, top, right, bottom } = bounds(inside);
    draft.set(id, {
      x: left - PADDING,
      y: top - PADDING,
      width: right - left + 2 * PADDING,
      height: bottom - top + 2 * PADDING,
    });
  }
}

/**
 * Draws shapes on a board: a shape whose id is on the board changes that
 * element, and any other is new. Returns each shape's id, in order, and the
 * elements to store.
 */
export function draw(
  stored: Map<string, Element>,
  shapes: Draw["shapes"],
  direction?: Draw["direction"],
) {
  const draft = new Draft(stored);
  const named = shapes.map((shape) => ({ ...shape, id: shape.id ?? name() }));
  const typed = (type: string) =>
    named.filter((shape) => (shape.type ?? draft.get(shape.id)?.type) === type);
  const [frames, arrows] = [typed("frame"), typed("arrow")];
  const boxes = named.filter((shape) => !frames.includes(shape) && !arrows.includes(shape));
  const loose = boxes.filter(({ id, x, y }) => x === undefined && y === undefined && !draft.get(id));
  // Frames go first and arrows last, so one call can list a shape before the
  // frame it sits in, and an arrow before the shapes it joins.
  for (const shape of [...frames, ...boxes]) place(draft, shape);
  layout(draft, loose, arrows, direction);
  for (const shape of arrows) connect(draft, shape);
  enclose(draft);
  return { ids: named.map(({ id }) => id), elements: [...draft.changed.values()] };
}

/**
 * Erases elements and their labels, leaving the shapes in an erased frame.
 * Returns the ids erased and the elements to store.
 */
export function erase(stored: Map<string, Element>, ids: string[]) {
  const draft = new Draft(stored);
  const erased = ids.filter((id) => draft.get(id));
  for (const id of erased) {
    for (const bound of draft.get(id)!.boundElements ?? [])
      if (bound.type === "text" && draft.get(bound.id))
        draft.set(bound.id, { isDeleted: true });
    draft.set(id, { isDeleted: true });
  }
  for (const { id, frameId } of draft.elements())
    if (frameId && erased.includes(frameId)) draft.set(id, { frameId: null });
  return { ids: erased, elements: [...draft.changed.values()] };
}

/** The board as an agent reads it: each element with its label folded in. */
export function describe(stored: Map<string, Element>): Seen[] {
  const draft = new Draft(stored);
  return draft
    .elements()
    .filter((element) => !element.containerId)
    .map((element) => {
      const bound = draft.get(element.boundElements?.find(({ type }) => type === "text")?.id);
      const text = element.type === "frame" ? element.name : (element.originalText ?? bound?.originalText);
      const fontSize = element.fontSize ?? bound?.fontSize ?? FONT_SIZE;
      const ink = element.type === "frame" ? FRAME.strokeColor : STROKE;
      const end = ["arrow", "line"].includes(element.type) ? element.points?.at(-1) : undefined;
      const [from, to] = [element.startBinding, element.endBinding].map((binding) =>
        draft.get(binding?.elementId) ? binding!.elementId : undefined,
      );
      return {
        id: element.id,
        type: element.type,
        x: Math.round(element.x),
        y: Math.round(element.y),
        width: Math.round(end?.[0] ?? element.width),
        height: Math.round(end?.[1] ?? element.height),
        ...(text && { text }),
        ...(fontSize !== FONT_SIZE && { fontSize }),
        ...(element.strokeColor !== ink && { color: element.strokeColor }),
        ...(element.backgroundColor !== "transparent" && { fill: element.backgroundColor }),
        ...(element.strokeStyle !== "solid" && { stroke: element.strokeStyle }),
        ...(draft.get(element.frameId) && { frame: element.frameId! }),
        ...(from && { from }),
        ...(to && { to }),
      };
    });
}
