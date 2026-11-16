// Discrete-effects fixture: a menu whose open-state `useEffect` adds the `window` capture
// listeners that close it (tests/e2e/discrete-effects.e2e.test.ts).
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  spa: { entry: "./src/main.tsx", title: "denext discrete effects fixture" },
} satisfies DenextConfig;
