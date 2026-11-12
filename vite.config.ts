import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import manifest from "./package.json" with { type: "json" };

// index.html loads the version of Excalidraw that the page is type-checked against.
process.env.VITE_EXCALIDRAW = manifest.devDependencies["@excalidraw/excalidraw"];

// The page is built twice: as the site Holon serves, and as the single file
// an MCP Apps host embeds. The site's paths are relative, because Holon serves
// it at the root in production and under /board/ in development.
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL("./ui", import.meta.url)),
  base: "./",
  // The site's icons and link previews; an embedded view needs none of them.
  publicDir: mode === "mcp" ? false : "public",
  plugins: mode === "mcp" ? [viteSingleFile()] : [],
  build: {
    outDir: mode === "mcp" ? "../dist/mcp" : "../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      external: ["@excalidraw/excalidraw", "react", "react-dom/client"],
    },
  },
}));
