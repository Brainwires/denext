// The Flight entry's deferred boot: `flight-boot.js`, written beside `flight.js` by a production
// build and `denext export`.
//
// `flight.js` statically imports the client runtime (the reconciler, Flight parsing,
// navigation), so a page that loads it fetches the shared runtime chunk up front. A page whose
// only client code is deferred islands (`client:idle` / `visible` / `interaction` / `media`, a
// resumable route) has nothing to run until one of them fires. The server gives such a page this
// boot instead (see `deferredBootEntry` in server/document.ts): a few hundred bytes of plain
// JavaScript that imports nothing up front.
//
// The boot re-checks the document, then waits for the first trigger of any island — an
// interaction inside a `client:interaction` island (or on a resumable handler host), an island
// scrolling near the viewport, the browser going idle, a media query matching — imports
// `flight.js` then, and hands the events it buffered to the runtime's delegated dispatcher
// (`resumeEvent`, the path a page that loaded the runtime up front takes), so the interaction
// that woke the page is not lost. A page that turns out to need the runtime now (a live handler
// outside every island, such as a resumable `<Link>`'s soft navigation) imports it at once.
//
// It is not bundled: it has no imports, and its one dynamic import (`./flight.js`) is resolved
// by the browser against the boot's own URL, so it works under any `basePath` or `assetPrefix`.

import { join } from "@std/path";
import { INTERACTION_EVENTS } from "../client/lazy-hydrate.ts";
import {
  ISLAND_MARKER_ATTR,
  ISLAND_PARAM_ATTR,
  ISLAND_STRATEGY_ATTR,
} from "../runtime/lazy-directive.ts";
import { DNX_H_ATTR } from "../runtime/qrl.ts";
import { FLIGHT_BUNDLE_FILE } from "./build-pipeline/context.ts";

/** The deferred boot's file name, beside {@linkcode FLIGHT_BUNDLE_FILE} in the client dir. */
export const FLIGHT_BOOT_FILE = "flight-boot.js";

/**
 * The boot's source: plain browser JavaScript with no static imports (comments and
 * indentation stripped, since it is not minified by a bundler).
 *
 * @returns The JavaScript source of `flight-boot.js`.
 */
export function generateFlightBoot(): string {
  const island = JSON.stringify(`[${ISLAND_MARKER_ATTR}]`);
  const handler = JSON.stringify(`[${DNX_H_ATTR}]`);
  const trigger = JSON.stringify(
    `[${ISLAND_MARKER_ATTR}][${ISLAND_STRATEGY_ATTR}="interaction"],[${DNX_H_ATTR}]`,
  );
  const strategy = JSON.stringify(ISLAND_STRATEGY_ATTR);
  const source = `// denext Flight boot — do not edit.
const d = document, warn = (e) => console.warn("denext: client runtime failed to load:", e && e.message);
let boot;
// Import flight.js (it hydrates and registers the islands); resolves to its resumeEvent.
const load = () => boot ??= import("./${FLIGHT_BUNDLE_FILE}").then((m) => m.ready);
const all = (sel) => d.querySelectorAll(sel);
// A live handler outside every island needs the runtime now (a resumable <Link>'s soft nav).
const now = [...all(${handler})].some((el) => !el.closest(${island}));
if (now) load().catch(warn);
else {
  const queue = [], undo = [], types = new Set(${JSON.stringify(INTERACTION_EVENTS)});
  for (const el of all(${handler})) {
    for (const p of el.getAttribute(${
    JSON.stringify(DNX_H_ATTR)
  }).split(/\\s+/)) if (p) types.add(p.split(":")[0]);
  }
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    load().then((resume) => {
      for (const f of undo) f();
      // The events the runtime's own dispatcher would have seen: the trigger, then the rest of
      // its gesture (pointerdown, focusin, click) that arrived while it loaded.
      for (const e of queue.splice(0)) if (resume) resume(e.target, e.type, e);
    }).catch(warn);
  };
  const on = (e) => {
    if (!fired && !e.target?.closest?.(${trigger})) return;
    queue.push(e);
    fire();
  };
  for (const t of types) {
    d.addEventListener(t, on, { passive: true });
    undo.push(() => d.removeEventListener(t, on));
  }
  for (const el of all(${island})) {
    const s = el.getAttribute(${strategy});
    if (s === "idle") (self.requestIdleCallback || setTimeout)(fire);
    else if (s === "visible") {
      if (!self.IntersectionObserver) fire();
      else {
        // The wrapper is display:contents (no box): observe the first boxed descendant.
        let box = el;
        while (box && getComputedStyle(box).display === "contents") box = box.firstElementChild;
        const o = new IntersectionObserver((es) => es.some((x) => x.isIntersecting) && fire(), { rootMargin: "200px" });
        o.observe(box || el);
        undo.push(() => o.disconnect());
      }
    } else if (s === "media") {
      const q = self.matchMedia && matchMedia(el.getAttribute(${
    JSON.stringify(ISLAND_PARAM_ATTR)
  }) || "");
      if (!q || q.matches) fire();
      else {
        const c = () => q.matches && fire();
        q.addEventListener("change", c);
        undo.push(() => q.removeEventListener("change", c));
      }
    } else if (s !== "interaction") {
      // An island that does not wait (load, only): the server gives such a page flight.js.
      fire();
    }
  }
}
`;
  return source.split("\n").map((line) => line.trim()).filter((line) =>
    line !== "" && !line.startsWith("//")
  ).join("\n") + "\n";
}

/**
 * Write (or, when the app has an `instrumentation-client`, remove) the deferred boot beside the
 * Flight entry. With an `instrumentation-client` every page keeps `flight.js`, which imports it
 * first: deferring it to an island's trigger would break its "before the app" contract.
 *
 * @param clientDir The client output dir `flight.js` was written to.
 * @param instrumentationClient The app's `instrumentation-client` path, or null.
 */
export async function writeFlightBoot(
  clientDir: string,
  instrumentationClient: string | null | undefined,
): Promise<void> {
  const path = join(clientDir, FLIGHT_BOOT_FILE);
  if (instrumentationClient) return await Deno.remove(path).catch(() => {});
  await Deno.writeTextFile(path, generateFlightBoot());
}

/** Whether `clientDir` holds a deferred boot (a production build wrote one). */
export async function hasFlightBoot(clientDir: string): Promise<boolean> {
  try {
    return (await Deno.stat(join(clientDir, FLIGHT_BOOT_FILE))).isFile;
  } catch {
    return false;
  }
}
