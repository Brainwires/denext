// Delegated qrl dispatch — run a serialized handler WITHOUT running its component
// (resumability, stage 4). The server stamps each interactive host with a
// `data-dnx-h="click:id input:id2"` attribute; here a single delegated listener per
// event type resolves the event to the nearest such host, looks up the qrl loader
// by id, imports the handler chunk, and runs it. No hydration, no tree execution.
//
// The qrl loader is registered when its module is imported (a module-scope `qrl(...)`,
// or the stage-4 transform's hoisted registration) — the client entry imports the
// app's client modules for their component registry, which also runs those
// registrations, so the loaders are present without any component having rendered.

import { DNX_H_ATTR, getQrlLoader } from "../runtime/qrl.ts";

/** Parse a `data-dnx-h` value into `{ eventType → qrlId }`. */
function parseHandlers(attr: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of attr.split(/\s+/)) {
    const i = pair.indexOf(":");
    if (i > 0) map[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return map;
}

/**
 * Resolve an event on `target` to the nearest ancestor host carrying a qrl handler
 * for `eventType`, and run it. Returns true if a handler was dispatched.
 */
export function dispatchQrl(target: unknown, eventType: string, event: unknown): boolean {
  let el = target as {
    nodeType?: number;
    parentNode?: unknown;
    getAttribute?: (n: string) => string | null;
  } | null;
  while (el) {
    if (el.nodeType === 1 && typeof el.getAttribute === "function") {
      const attr = el.getAttribute(DNX_H_ATTR);
      if (attr) {
        const id = parseHandlers(attr)[eventType];
        if (id) {
          const loader = getQrlLoader(id);
          if (loader) {
            void loader().then((fn) => fn(event)).catch((err) =>
              console.warn("denext: qrl handler failed:", (err as Error)?.message)
            );
            return true;
          }
        }
      }
    }
    el = (el.parentNode ?? null) as typeof el;
  }
  return false;
}

/**
 * Install one delegated capture-phase listener per event type that appears in a
 * `data-dnx-h` on the page, so serialized handlers dispatch without hydration.
 * Idempotent.
 */
export function installQrlDispatch(): void {
  const w = globalThis as unknown as { __dnxQrlDispatch?: boolean; document?: Document };
  const doc = w.document;
  if (typeof doc === "undefined" || w.__dnxQrlDispatch) return;
  w.__dnxQrlDispatch = true;
  const types = new Set<string>();
  doc.querySelectorAll(`[${DNX_H_ATTR}]`).forEach((el) => {
    const attr = el.getAttribute(DNX_H_ATTR);
    if (attr) { for (const t of Object.keys(parseHandlers(attr))) types.add(t); }
  });
  for (const type of types) {
    doc.addEventListener(type, (event) => {
      dispatchQrl(event.target, event.type, event);
    }, true); // capture: reach the handler before any bubble-phase logic
  }
}
