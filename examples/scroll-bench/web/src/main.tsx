// The SPA entry. Runs a cell from the query string, or from the deep links the adb harness
// sends (`denextscrollbench://run?list=…&kind=…&n=…` and `…://action?op=append&k=50`).

import { createRoot } from "denext/client";
import { onDeepLink } from "denext/mobile";
import {
  type BenchLink,
  parseLink,
  parseRunParams,
  type RunParams,
  SCHEMES,
} from "../../shared/scenarios.ts";
import { App } from "./app.tsx";
import { bench, installErrorReporting, runAction } from "./bench.ts";
import { BENCH_CSS } from "./styles.ts";

installErrorReporting();
globalThis.__bench = bench;

const style = document.createElement("style");
style.textContent = BENCH_CSS;
document.head.append(style);

// The latest run link, replayed to a late subscriber (the launch link can arrive before the
// App's effect subscribes).
let lastRun: RunParams | null = null;
const runListeners = new Set<(p: RunParams) => void>();
const subscribe = (fn: (p: RunParams) => void) => {
  runListeners.add(fn);
  if (lastRun) fn(lastRun);
  return () => void runListeners.delete(fn);
};

// Subscribed before the first render so the launch link is not missed (denext/mobile delivers
// it once per page). Does nothing outside the Capacitor shell.
function startRun(params: RunParams): void {
  lastRun = params;
  for (const fn of runListeners) fn(params);
}

function onLink(link: BenchLink): void {
  if (link.type === "run") startRun(link.params);
  else void runAction(link.params);
}

onDeepLink(({ url }) => {
  const link = parseLink(url);
  if (link) onLink(link);
}, { accept: { schemes: [SCHEMES.denext] }, route: false });

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <App initial={parseRunParams(location.search)} subscribe={subscribe} />,
  );
}
