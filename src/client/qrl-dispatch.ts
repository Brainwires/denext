// The delegated resumability dispatcher (resumability, stage 4). The server stamps
// each interactive host with `data-dnx-h`; a single bubble-phase listener per event
// type resolves an event to the nearest such host and either:
//   - runs a `qrl` handler directly (its id is in the attribute) — no component ever
//     mounts; the loader was registered when the client module was imported; or
//   - resumes the enclosing `client:interaction` island synchronously and replays
//     the event, so the just-attached real handler fires (a plain handler that closes
//     over component state — the common case, correct for arbitrary closures).
//
// This is what makes resumable mode work: with every island auto-deferred, the page
// is interactive with no up-front tree execution, and the FIRST interaction resumes
// only the touched island.

import { DNX_H_ATTR, getQrlLoader } from "../runtime/qrl.ts";
import { dispatchInteraction, INTERACTION_EVENTS } from "./lazy-hydrate.ts";

/**
 * Parse a `data-dnx-h` value into `{ eventType → qrlId }`. An entry may be
 * `"click:qrlId"` (a qrl, dispatchable without mounting) or bare `"click"` (a plain
 * handler → empty id, resumed by hydrating its island).
 */
function parseHandlers(attr: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of attr.split(/\s+/)) {
    if (!pair) continue;
    const i = pair.indexOf(":");
    if (i === -1) map[pair] = "";
    else map[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return map;
}

/**
 * Resolve an event on `target` to the nearest ancestor host carrying a qrl handler
 * for `eventType`, and run it. Returns true if a handler was dispatched.
 *
 * Security note: this honors `data-dnx-h` on ANY element. denext's own server
 * escaping never emits that attribute from user data, so this is safe for framework
 * output — but an app that injects untrusted HTML through an over-permissive
 * sanitizer (one that preserves `data-*`) via `dangerouslySetInnerHTML` could let a
 * crafted element fire an already-registered app handler. Sanitize untrusted HTML
 * (strip `data-dnx-*`), the same caveat as any raw-HTML injection.
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
 * Install the single delegated resumability dispatcher: one bubble-phase listener
 * per relevant event type (the interaction-trigger set ∪ every event type present
 * in a `data-dnx-h` on the page). Bubble phase means the event has already passed
 * the target with no live handler, so resuming cannot double-fire.
 *
 * Idempotent AND re-callable: the set of already-listened event types is kept on a
 * document-global, so a soft-nav re-boot that brings in a route using a NEW event
 * type (e.g. the first page had only `click`, the next uses `input`) adds a listener
 * for it, while never double-registering a type already covered.
 */
export function installQrlDispatch(): void {
  const w = globalThis as unknown as { __dnxQrlTypes?: Set<string>; document?: Document };
  const doc = w.document;
  if (typeof doc === "undefined") return;
  const registered = (w.__dnxQrlTypes ??= new Set<string>());
  const needed = new Set<string>(INTERACTION_EVENTS);
  doc.querySelectorAll(`[${DNX_H_ATTR}]`).forEach((el) => {
    const attr = el.getAttribute(DNX_H_ATTR);
    if (attr) { for (const t of Object.keys(parseHandlers(attr))) needed.add(t); }
  });
  for (const type of needed) {
    if (registered.has(type)) continue; // a listener for this type is already live
    registered.add(type);
    doc.addEventListener(type, (event) => resumeEvent(event.target, event.type, event), false);
  }
}

/** The outcome of {@link resumeEvent}. */
export type ResumeResult = "qrl" | "resumed" | "none";

/**
 * Handle a delegated event: a qrl dispatches without mounting; otherwise, if the
 * target sits in a pending `client:interaction` island, resume that island
 * synchronously and replay the event so the just-attached real handler fires.
 */
export function resumeEvent(target: unknown, eventType: string, event: unknown): ResumeResult {
  if (dispatchQrl(target, eventType, event)) return "qrl";
  if (dispatchInteraction(target as Element | null)) {
    replayEvent(event as Event);
    return "resumed";
  }
  return "none";
}

/** Re-dispatch `event` to its target so a handler attached during resume fires. */
function replayEvent(event: Event): void {
  const target = event.target as (EventTarget & { dispatchEvent?: (e: Event) => boolean }) | null;
  if (!target || typeof target.dispatchEvent !== "function") return;
  try {
    const Ctor = (event.constructor as { new (t: string, e: Event): Event }) ?? Event;
    target.dispatchEvent(new Ctor(event.type, event));
  } catch {
    try {
      target.dispatchEvent(new Event(event.type, { bubbles: true, cancelable: true }));
    } catch { /* target cannot receive a synthetic event */ }
  }
}
