import { holon } from "holon-ui/vite";
import { defineConfig } from "vite";
import manifest from "./package.json" with { type: "json" };

// index.html loads the version of Excalidraw that the page is type-checked against.
process.env.VITE_EXCALIDRAW = manifest.devDependencies["@excalidraw/excalidraw"];

export default defineConfig({
  plugins: [holon()],
  // Excalidraw and React load from esm.sh, through index.html's import map.
  build: { rolldownOptions: { external: ["@excalidraw/excalidraw", "react", "react-dom/client"] } },
});
