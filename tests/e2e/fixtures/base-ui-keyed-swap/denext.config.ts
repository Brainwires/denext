import type { DenextConfig } from "denext/server";
export default {
  mode: "spa",
  nextCompat: true,
  spa: { entry: "./src/main.tsx", title: "keyed swap" },
} satisfies DenextConfig;
