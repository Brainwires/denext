// SPA-assets fixture: exercises Vite-style asset imports on the compat path —
// `?url` (a binary asset → emitted file + URL) and `?worker` (a module bundled as
// its own chunk + a `new Worker(url)` stub). `nextCompat: true` forces the esbuild
// compat pipeline (no npm deps needed). Built from a temp copy by the e2e test.
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  nextCompat: true,
  spa: { entry: "./src/main.tsx", title: "spa assets" },
} satisfies DenextConfig;
