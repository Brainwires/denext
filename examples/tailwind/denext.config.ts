import type { DenextConfig } from "denext/server";

export default {
  // denext compiles `styles/tailwind.css` -> `app/globals.css` with the Tailwind
  // v4 standalone binary, which denext downloads and manages itself (no npm, no
  // PostCSS config). The layout imports the compiled `./globals.css`.
  tailwind: { input: "styles/tailwind.css", output: "app/globals.css" },
} satisfies DenextConfig;
