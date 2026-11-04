// SPA mode's deferred mount: what a `client:*` component element becomes in a SPA build (see
// src/build/spa-islands.ts). Until its trigger fires it renders a placeholder (the element's
// `client:placeholder`, else an empty element); then it imports the component's module (its own
// chunk when nothing else imports it) and mounts the component with the element's props.
//
//   client:load        mount now (the chunk still loads on its own)
//   client:only        the same (there is no server render to skip in a SPA)
//   client:idle        mount when the main thread is idle
//   client:visible     mount when the placeholder nears the viewport (200px margin)
//   client:media="q"   mount when the media query matches
//   client:interaction mount on the first pointerdown / click / keydown / focusin / touchstart
//                      inside the placeholder (give it a `client:placeholder` to interact with)
//
// The triggers are the Flight islands' own (lazy-hydrate.ts registers and fires them), so
// `setLazyScheduler` drives them in tests and the dev island timeline records each mount. The
// interaction that mounts a `client:interaction` island is replayed on the mounted component, as
// a Flight island replays it on its hydrated DOM: every event of the gesture (pointerdown →
// focusin → click) that lands on the placeholder before the component commits is dispatched again
// to the element at the same position in the component's DOM (its first element when the
// placeholder has no such element), and a focus moves there. A press (pointerdown / touchstart /
// keydown) starts the import at once but holds the mount until it is released: a component
// committed mid-press would take the release, and the browser's click would then target the
// removed placeholder and never fire, so the click that completes the press is held and replayed
// with the rest (the mount waits for that click, or `CLICK_GRACE_MS` past a release
// that brings none, and at most `PRESS_CAP_MS` for a release that never comes).

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType } from "../jsx/types.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "../runtime/hooks.ts";
import { parseStrategy } from "../runtime/lazy-directive.ts";
import {
  dispatchInteraction,
  dropDetachedLazyIslands,
  INTERACTION_EVENTS,
  registerLazyIsland,
} from "./lazy-hydrate.ts";

/** Imports the deferred component (the build's loader: `() => import(...).then(...)`). */
export type SpaIslandLoader = () => Promise<unknown>;

/** Props of {@linkcode SpaIsland}: the loader, the directive, and the component's own props. */
export interface SpaIslandProps {
  /** Imports the component (written by the build; one per imported component and module). */
  readonly __dnxLoad: SpaIslandLoader;
  /** Rendered until the component mounts (the placeholder `client:interaction` listens on). */
  readonly "client:placeholder"?: VNodeChild;
  /** The component's own props and the `client:*` directive. */
  readonly [prop: string]: unknown;
}

/** One import per loader (the loaders are module constants, so a list's islands share it). */
const imports = new WeakMap<SpaIslandLoader, Promise<VNodeType>>();

/** The component a loader resolves to (imported once). */
function load(loader: SpaIslandLoader): Promise<VNodeType> {
  let p = imports.get(loader);
  if (!p) {
    p = loader() as Promise<VNodeType>;
    imports.set(loader, p);
  }
  return p;
}

/**
 * The gesture that mounted an island, held until the component commits: where the placeholder
 * sat in `parent` (`start`, with `tail` nodes after it) and each event with its target's
 * element-index path below the placeholder.
 */
interface Gesture {
  parent: Node;
  start: number;
  tail: number;
  events: Array<[Event, number[]]>;
}

/** Events that start a press: the mount waits for its release (and the click it brings). */
const PRESS_EVENTS: ReadonlySet<string> = new Set(["pointerdown", "touchstart", "keydown"]);

/** Events that end a press, wherever they land (a press dragged off the placeholder too). */
const RELEASE_EVENTS = ["pointerup", "pointercancel", "touchend", "touchcancel", "keyup"] as const;

/** How long past a release the mount waits for its click (a tap's click follows its touchend). */
const CLICK_GRACE_MS = 100;

/** The longest a press holds the mount when no release reaches the page. */
const PRESS_CAP_MS = 3000;

/** A press in progress: `done` ends it (the click came, or the release's grace or the cap ran out). */
interface Press {
  readonly ended: Promise<void>;
  readonly done: () => void;
}

/** A listener target: the document, or (a test DOM without one) the placeholder's top ancestor. */
type ListenerHost = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** Where a press's release is heard: the placeholder's document, else its topmost ancestor. */
function releaseHost(el: Element): ListenerHost {
  const doc = el.ownerDocument as Partial<ListenerHost> | null;
  if (typeof doc?.addEventListener === "function") return doc as ListenerHost;
  let top: Node = el;
  while (top.parentNode) top = top.parentNode;
  return top;
}

/**
 * Start a press on `el`: it ends at the click that completes it, `CLICK_GRACE_MS` past a
 * release that brings no click, or `PRESS_CAP_MS` after it began.
 */
function startPress(el: Element): Press {
  const host = releaseHost(el);
  let grace: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => (finish = resolve));
  const release = (): void => {
    clearTimeout(grace);
    grace = setTimeout(done, CLICK_GRACE_MS);
  };
  const cap = setTimeout(done, PRESS_CAP_MS);
  function done(): void {
    clearTimeout(grace);
    clearTimeout(cap);
    for (const type of RELEASE_EVENTS) host.removeEventListener(type, release, true);
    finish();
  }
  // Capture phase: a handler that stops the release's propagation still ends the press.
  for (const type of RELEASE_EVENTS) host.addEventListener(type, release, true);
  return { ended, done };
}

const indexIn = (list: ArrayLike<Node>, node: Node): number =>
  Array.prototype.indexOf.call(list, node);

/** `target`'s element-index path below `root` (empty for `root` itself, or outside it). */
function pathTo(root: Element, target: Element | null): number[] {
  const path: number[] = [];
  for (let n = target; n && n !== root; n = n.parentNode as Element | null) {
    const parent = n.parentNode as Element | null;
    if (!parent?.children) return [];
    path.unshift(indexIn(parent.children, n));
  }
  return path;
}

/**
 * The element of the mounted component at `path` (the placeholder's top-level elements are the
 * component's): each index descends while the component's DOM has an element there; the first
 * element when it has none at the top.
 */
function resolvePath(g: Gesture, path: number[]): Element | null {
  const nodes = Array.prototype.slice.call(
    g.parent.childNodes,
    g.start,
    g.parent.childNodes.length - g.tail,
  ) as Node[];
  const tops = nodes.filter((n) => n.nodeType === 1) as Element[];
  let el: Element | undefined = tops[path[0] ?? 0];
  if (!el) return tops[0] ?? null;
  for (let i = 1; i < path.length && el.children[path[i]]; i++) el = el.children[path[i]];
  return el;
}

/** Replay a held gesture on the component's DOM: each event again, a focus moved there. */
function replay(g: Gesture): void {
  for (const [event, path] of g.events) {
    const el = resolvePath(g, path) as (Element & { focus?: () => void }) | null;
    if (!el) return;
    if (event.type === "focusin") {
      el.focus?.();
      continue;
    }
    try {
      const Ctor = event.constructor as new (type: string, init: Event) => Event;
      el.dispatchEvent(new Ctor(event.type, event));
    } catch { /* an event its constructor can't rebuild is dropped */ }
  }
}

/**
 * Fire the island's interaction trigger on the first interaction inside `el`, hold that
 * gesture's events (`held`) until the component commits, and track a press in progress (`press`)
 * so the mount waits for its release.
 */
function listenForInteraction(
  el: Element,
  held: { current: Gesture | null },
  press: { current: Press | null },
): () => void {
  const on = (e: Event): void => {
    const target = e.target as Element | null;
    const parent = el.parentNode;
    if (!held.current && parent) {
      const start = indexIn(parent.childNodes, el);
      held.current = { parent, start, tail: parent.childNodes.length - start - 1, events: [] };
    }
    // The wrapper is `display: contents` around the placeholder (or empty): its children are
    // the placeholder's top-level elements.
    held.current?.events.push([e, pathTo(el, target)]);
    if (e.type === "click") press.current?.done();
    else if (PRESS_EVENTS.has(e.type) && !press.current) {
      const p = startPress(el);
      press.current = p;
      void p.ended.then(() => {
        if (press.current === p) press.current = null;
      });
    }
    void dispatchInteraction(target);
  };
  // Passive: the listener only starts the mount, and a non-passive touchstart would hold every
  // scroll that begins on the placeholder on the main thread.
  for (const type of INTERACTION_EVENTS) el.addEventListener(type, on, { passive: true });
  return () => {
    for (const type of INTERACTION_EVENTS) el.removeEventListener(type, on);
    press.current?.done();
  };
}

/** What has loaded: nothing yet, the component, or the import's failure. */
type Loaded = { readonly C?: VNodeType; readonly error?: unknown };

/**
 * A `client:*` component element in a SPA: the placeholder until the trigger, then the
 * component (its chunk imported first). A failed import throws to the nearest error boundary.
 *
 * @param props The loader, the directive (and `client:placeholder`), and the component's props.
 * @returns The placeholder, or the mounted component.
 */
export function SpaIsland(props: SpaIslandProps): VNode | null {
  const { __dnxLoad: loader, "client:placeholder": placeholder, ...own } = props;
  const { strategy, param, rest } = parseStrategy(own);
  const [loaded, setLoaded] = useState<Loaded>({});
  const box = useRef<Element | null>(null);
  const held = useRef<Gesture | null>(null);
  const press = useRef<Press | null>(null);
  // The component committed: replay the gesture that mounted it on its DOM.
  useLayoutEffect(() => {
    const g = held.current;
    held.current = null;
    if (g && loaded.C) replay(g);
  }, [loaded.C]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let live = true;
    // An island unmounted before its trigger never imports. The import starts at once; the
    // mount waits for a press in progress to end (its click is then held for the replay).
    const mount = (): Promise<void> | undefined =>
      live
        ? load(loader).then(
          async (C) => {
            await press.current?.ended;
            if (live) setLoaded({ C });
          },
          (error) => void (live && setLoaded({ error })),
        )
        : undefined;
    const off = strategy === "interaction" ? listenForInteraction(el, held, press) : undefined;
    registerLazyIsland({ container: el, strategy: strategy ?? "load", param, hydrate: mount });
    return () => {
      live = false;
      off?.();
      queueMicrotask(dropDetachedLazyIslands);
    };
  }, []);
  if (loaded.error !== undefined) throw loaded.error;
  if (loaded.C) return h(loaded.C, rest);
  const contents = placeholder !== undefined && placeholder !== null;
  return h("div", {
    ref: box,
    "data-dnx-island": "",
    "data-dnx-strategy": strategy ?? "load",
    style: contents ? { display: "contents" } : undefined,
  }, contents ? placeholder : null);
}
