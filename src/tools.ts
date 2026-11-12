import { z } from "zod";

/** The board's view, which an MCP Apps host shows when an agent reads a board. */
export const viewUri = "ui://board/view.html";
/** Hides a tool that only the board's page calls from agents. */
const page = { ui: { visibility: ["app"] } };

const board = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe("The board's id, as in its URL.");

const shape = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Names the shape. The id of a shape on the board changes that shape, keeping the fields you leave out.",
    ),
  type: z
    .enum(["rectangle", "ellipse", "diamond", "text", "arrow", "frame"])
    .optional()
    .describe("Required for a new shape."),
  x: z
    .number()
    .optional()
    .describe("Left edge, in pixels. Leave out x and y of a new shape to have the board place it."),
  y: z.number().optional().describe("Top edge, in pixels. y grows downward."),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  text: z
    .string()
    .max(2000)
    .optional()
    .describe("The label of a box or an arrow, what a text shape says, or a frame's name."),
  fontSize: z
    .number()
    .min(8)
    .max(200)
    .optional()
    .describe("The text's size in pixels: 20 unless given, 28 or 36 for a heading."),
  color: z.string().optional().describe("Stroke color, as a CSS color."),
  fill: z.string().optional().describe("A box's background, as a CSS color."),
  stroke: z
    .enum(["solid", "dashed", "dotted"])
    .optional()
    .describe("The line of a box's outline or an arrow."),
  frame: z
    .string()
    .optional()
    .describe("The id of the frame the shape sits in. An empty string takes it out."),
  from: z.string().optional().describe("The id of the shape an arrow leaves."),
  to: z.string().optional().describe("The id of the shape an arrow points at."),
});

const seen = z.object({
  id: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  text: z.string().optional(),
  fontSize: z.number().optional(),
  color: z.string().optional(),
  fill: z.string().optional(),
  stroke: z.string().optional(),
  frame: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

/** An Excalidraw element, of which the server checks only what decides a merge and when it last changed. */
export const element = z.looseObject({
  id: z.string().min(1).max(64),
  version: z.number().int().nonnegative(),
  versionNonce: z.number().int(),
  isDeleted: z.boolean(),
  updated: z.number().optional(),
});

const client = z
  .string()
  .min(1)
  .max(64)
  .describe("Names the calling page, so that it is not told its own changes.");

const cursor = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  selected: z.array(z.string()),
});

const image = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe("The fileId of the image's Excalidraw element.");

/** An image's file as a data URL, which is 1.5 MB of image at its longest. */
const dataURL = z
  .string()
  .max(2_000_000)
  .regex(/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+=*$/);

/** What a page on a board is told as it happens: the elements others stored, and where the others are. */
export const changed = {
  description:
    "A board changed: someone stored elements, moved their pointer or left. The page named by client is not told its own changes.",
  inputSchema: z.strictObject({ board, client }),
  payloadSchema: z.object({
    seq: z.number().int().optional().describe("The board's count of changes after these elements."),
    elements: z.array(element).optional(),
    cursors: z.array(cursor).optional(),
    gone: z.array(z.string()).optional().describe("The ids of cursors that left."),
  }),
};

export type Element = z.infer<typeof element>;
export type Cursor = z.infer<typeof cursor>;
export type Change = z.infer<typeof changed.payloadSchema>;

export const tools = {
  read_board: {
    description:
      "Read a shared Excalidraw board and open it. Returns its shapes and the URL where anyone can watch and edit it live. Leave out board to start a new one.",
    inputSchema: z.strictObject({ board: board.optional() }),
    outputSchema: z.object({ board, url: z.string(), shapes: z.array(seen) }),
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: viewUri } },
  },
  draw: {
    description:
      "Draw on a board: boxes (rectangle, ellipse, diamond), text, arrows between two shapes, and frames that hold shapes under a name. Everyone with the board open sees it at once. Give shapes your own short ids to join them with arrows and put them in frames in the same call. Leave out x and y, and the board lays new shapes out along their arrows, below what is already there. A box sizes itself to its text unless you give a width and height, and a frame wraps the shapes in it.",
    inputSchema: z.strictObject({
      board,
      shapes: z.array(shape).min(1).max(500),
      direction: z
        .enum(["right", "down"])
        .optional()
        .describe("Which way arrows run between the shapes the board places: right unless given."),
    }),
    outputSchema: z.object({
      ids: z.array(z.string()).describe("Each shape's id, in the order given."),
    }),
    annotations: { destructiveHint: false },
  },
  erase: {
    description:
      "Erase shapes from a board by id. An arrow attached to an erased shape stays, so erase it too if it should go. The shapes in an erased frame stay.",
    inputSchema: z.strictObject({ board, ids: z.array(z.string()).min(1).max(500) }),
    outputSchema: z.object({
      ids: z.array(z.string()).describe("The ids that were on the board and are now erased."),
    }),
  },
  sync: {
    description:
      "For the board's page: send the Excalidraw elements it changed and where its pointer is. With since, also receive the elements changed elsewhere and everyone else's cursors.",
    inputSchema: z.strictObject({
      board,
      client,
      since: z.number().int().nonnegative().optional(),
      elements: z.array(element).max(5000),
      presence: z
        .strictObject({
          name: z.string().min(1).max(40),
          x: z.number(),
          y: z.number(),
          selected: z.array(z.string().max(64)).max(200),
        })
        .optional(),
    }),
    outputSchema: z.object({
      epoch: z
        .number()
        .describe("Changes when the server has lost its boards: send every element again."),
      seq: z.number().int().describe("Pass as since next time."),
      elements: z.array(element),
      cursors: z.array(cursor),
    }),
    annotations: { destructiveHint: false },
    _meta: page,
  },
  put_image: {
    description: "For the board's page: store the file of an image on the board, as a data URL.",
    inputSchema: z.strictObject({ board, id: image, dataURL }),
    outputSchema: z.object({}),
    annotations: { destructiveHint: false, idempotentHint: true },
    _meta: page,
  },
  get_image: {
    description:
      "For the board's page: read the file of an image on the board, as a data URL. Without one, the board has no such file.",
    inputSchema: z.strictObject({ board, id: image }),
    outputSchema: z.object({ dataURL: dataURL.optional() }),
    annotations: { readOnlyHint: true },
    _meta: page,
  },
};
