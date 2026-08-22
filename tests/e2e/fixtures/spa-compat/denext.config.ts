import type { DenextConfig } from "denext/server";
export default {
  mode: "spa",
  nextCompat: true,
  spa: { entry: "./src/main.tsx", title: "compat spa", env: { MODE: "e2e-compat" } },
} satisfies DenextConfig;
