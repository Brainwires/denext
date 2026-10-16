// `lustreIsland`: a Lustre app as a denext island. Export the component it returns from a
// `"use client"` module and render it from a Server Component like any other island (every
// `client:*` directive applies).
//
// On the server the island renders the app's first view as HTML (`element.to_string` of
// `view(init(flags))`) inside its root element. In the browser, after hydration, Lustre starts on
// that root: it virtualises the markup already there and diffs its first render against it, so the
// server's nodes (and what the user typed or focused before the island booted) are kept. The root's
// contents are Lustre's from then on; denext renders the root once and never touches its children
// again; the root then gets a `lustre:mount` event. Unmounting clears the root itself: `lustre.shutdown()` does nothing for a client app in
// Lustre 5.7.1, so effects the app started may still dispatch into the detached runtime.

import { h } from "../jsx/jsx-runtime.ts";
import type { VNode } from "../jsx/types.ts";
import { useEffect, useRef, useState } from "../runtime/hooks.ts";
import type { LustreApp, LustreKit } from "./kit.ts";

/** How {@link lustreIsland} maps the component's props onto the app. */
export interface LustreIslandOptions<Flags, Props> {
  /**
   * The app's flags from the component's props. Default: the `flags` prop
   * (`<Counter flags={1} />`).
   */
  flags?: (props: Props) => Flags;
  /** The root element's tag. Default: `div`. */
  tag?: string;
  /** Attributes for the root element (`class`, `id`, …), from the props. */
  attributes?: (props: Props) => Record<string, string>;
}

/** The marker attribute on every Lustre island's root. */
const ROOT_MARKER = "data-denext-lustre";

/** Props that never reach the flags' dependencies. */
const NOT_FLAGS = new Set(["children", "key", "ref"]);

/** The props' values in key order: the island restarts the app when one changes. */
function propDeps(props: Record<string, unknown>): unknown[] {
  return Object.keys(props).filter((k) => !NOT_FLAGS.has(k)).sort().map((k) => props[k]);
}

/**
 * Turn a Lustre app into a denext island component. Export the result from a `"use client"`
 * module.
 *
 * @param kit The app's Lustre build (`import { lustre } from "../.denext/lustre.ts"`, written by
 *   the Gleam build when the app depends on Lustre).
 * @param app The Lustre app (`counter.app()`); its flags type comes from Gleam's `.d.mts`.
 * @param options How props become flags, and the root element.
 * @returns The island component.
 * @example
 * ```ts
 * "use client";
 * import { lustreIsland } from "denext/gleam";
 * import { lustre } from "../.denext/lustre.ts";
 * import * as counter from "@gleam/app/counter.mjs";
 *
 * export const Counter = lustreIsland(lustre, counter.app(), {
 *   flags: (props: { start: number }) => props.start,
 * });
 * // In a Server Component: <Counter start={1} client:visible />
 * ```
 */
export function lustreIsland<Flags, Props extends object = { flags: Flags }>(
  kit: LustreKit,
  app: LustreApp<Flags>,
  options: LustreIslandOptions<Flags, Props> = {},
): (props: Props) => VNode {
  const flagsOf = options.flags ??
    ((props: Props) => (props as unknown as { flags: Flags }).flags);
  const tag = options.tag ?? "div";
  return function LustreIsland(props: Props): VNode {
    const root = useRef<Element | null>(null);
    const latest = useRef(props);
    latest.current = props;
    // The first paint, rendered once: the server's HTML, and what hydration keeps. Later flags
    // restart the app in the same root instead of re-rendering it here, so denext never writes
    // over the DOM Lustre owns.
    const [html] = useState(() => kit.render(app, flagsOf(props)));
    useEffect(() => {
      const el = root.current;
      if (!el) return;
      const runtime = kit.start(app, el, flagsOf(latest.current));
      // Lustre runs the root from now on (what a page, or a test, can wait for).
      if (runtime) el.dispatchEvent?.(new CustomEvent("lustre:mount"));
      return () => {
        if (runtime) kit.stop(runtime);
        el.textContent = "";
      };
    }, propDeps(props as Record<string, unknown>));
    return h(tag, {
      ...options.attributes?.(props),
      [ROOT_MARKER]: "",
      ref: root,
      dangerouslySetInnerHTML: { __html: html },
    });
  };
}
