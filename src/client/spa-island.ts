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
// triggering interaction is not replayed: the placeholder is not the component's DOM.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode, VNodeChild, VNodeType } from "../jsx/types.ts";
import { useEffect, useRef, useState } from "../runtime/hooks.ts";
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

/** Fire the island's interaction trigger on the first interaction inside `el`. */
function listenForInteraction(el: Element): () => void {
  const on = (e: Event): void => void dispatchInteraction(e.target as Element | null);
  for (const type of INTERACTION_EVENTS) el.addEventListener(type, on);
  return () => {
    for (const type of INTERACTION_EVENTS) el.removeEventListener(type, on);
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
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let live = true;
    // An island unmounted before its trigger never imports.
    const mount = (): Promise<void> | undefined =>
      live
        ? load(loader).then(
          (C) => void (live && setLoaded({ C })),
          (error) => void (live && setLoaded({ error })),
        )
        : undefined;
    const off = strategy === "interaction" ? listenForInteraction(el) : undefined;
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
