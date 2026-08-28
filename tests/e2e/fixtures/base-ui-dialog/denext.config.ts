import type { DenextConfig } from "denext/server";
export default {
  mode: "spa",
  compatibilityMode: true,
  spa: { entry: "./src/main.tsx", title: "base-ui dialog" },
} satisfies DenextConfig;
