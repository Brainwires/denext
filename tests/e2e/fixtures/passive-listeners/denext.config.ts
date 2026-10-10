// Passive-listener fixture: a ScrollArea-like viewport with `onTouchStart` / `onTouchMove` /
// `onWheel` handlers (and their Capture variants), as Base UI's ScrollArea has. React DOM listens
// to those three passive, so the browser scrolls without waiting on them
// (tests/e2e/passive-listeners.e2e.test.ts).
import type { DenextConfig } from "denext/server";

export default {
  mode: "spa",
  spa: { entry: "./src/main.tsx", title: "denext passive listeners fixture" },
} satisfies DenextConfig;
