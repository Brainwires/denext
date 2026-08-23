// The `client:*` hydration directive — shared by the server renderer (which reads
// it off an island's props and stamps the strategy into the Flight boundary) and
// the client (which registers the island for deferred hydration instead of
// hydrating it eagerly).
//
// Authoring (see the resumability plan): a namespaced JSX attribute on a client
// island — `<Counter client:visible />` — surfaces at runtime as the prop key
// `"client:visible"` with value `true`. An optional module-level default
// `export const hydrate = "visible"` supplies a per-component baseline. Precedence:
// usage-site prop > module default > eager (no directive → today's behavior).

/**
 * When a `client:*` island hydrates. `load` is eager-but-per-island. `media`
 * hydrates when a CSS media query matches (its query is carried alongside the
 * strategy). `only` skips SSR entirely — the island renders on the client only.
 */
export type HydrationStrategy = "load" | "idle" | "visible" | "interaction" | "media" | "only";

/** The valid strategy names, in directive form. */
export const HYDRATION_STRATEGIES: readonly HydrationStrategy[] = [
  "load",
  "idle",
  "visible",
  "interaction",
  "media",
  "only",
];

/** The prop key the server stamps a resolved strategy under on a Flight boundary. */
export const STRATEGY_PROP = "__dnxHydrate";

/**
 * Marks a host node in the page Flight tree as a *foreign* subtree: the page-root
 * reconciler adopts the element but does not reconcile or sync its children, so a
 * separate per-island `hydrateRoot` can own that DOM. A framework-internal prop
 * (like every `__dnx*` key, it is never written to the DOM — see `applyProps`).
 */
export const FOREIGN_PROP = "__dnxForeign";

// A lazy island's server DOM is nested in a plain, layout-neutral wrapper
// (`<div data-dnx-island style="display:contents">`) — a standard element with
// `data-*` attributes, matching React/Next output rather than a custom element.
/** The wrapper element a lazy island's server DOM is nested in. */
export const ISLAND_TAG = "div";
/** Boolean marker attribute identifying an island wrapper (client discovery key). */
export const ISLAND_MARKER_ATTR = "data-dnx-island";
/** Attribute carrying a lazy island's tree-path id. */
export const ISLAND_ID_ATTR = "data-dnx-id";
/** Attribute carrying a lazy island's hydration strategy. */
export const ISLAND_STRATEGY_ATTR = "data-dnx-strategy";
/** Attribute carrying a strategy parameter (the media query for `client:media`). */
export const ISLAND_PARAM_ATTR = "data-dnx-strategy-param";

const PREFIX = "client:";

function isStrategy(s: string): s is HydrationStrategy {
  return (HYDRATION_STRATEGIES as readonly string[]).includes(s);
}

/**
 * Extract a `client:*` directive from an island's props. Returns the resolved
 * strategy (or null if none/invalid), an optional strategy parameter (the media
 * query, for `client:media="(min-width:800px)"`), and a copy of the props with
 * every `client:*` key removed so the marker never reaches the real DOM.
 *
 * @param props The island element's props.
 * @param moduleDefault A `hydrate` export from the island's own module, if any.
 */
export function parseStrategy(
  props: Record<string, unknown>,
  moduleDefault?: unknown,
): { strategy: HydrationStrategy | null; param?: string; rest: Record<string, unknown> } {
  let strategy: HydrationStrategy | null = null;
  let param: string | undefined;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith(PREFIX)) {
      // `client:visible` (boolean-shorthand true) or `client="visible"`-style value.
      // `client:media="(min-width:800px)"` names the strategy in the key and carries
      // its query as the value.
      const name = key.slice(PREFIX.length);
      if (name && isStrategy(name) && value !== false) {
        strategy = name; // usage-site prop wins
        if (name === "media" && typeof value === "string") param = value;
      } else if (typeof value === "string" && isStrategy(value)) {
        strategy = value;
      }
      continue; // strip every client:* key regardless
    }
    rest[key] = value;
  }
  if (strategy === null && typeof moduleDefault === "string" && isStrategy(moduleDefault)) {
    strategy = moduleDefault; // module default fills in only when no usage-site prop
  }
  return { strategy, param, rest };
}

/** Read a strategy the server stamped under {@link STRATEGY_PROP}, if valid. */
export function readStampedStrategy(props: Record<string, unknown>): HydrationStrategy | null {
  const v = props[STRATEGY_PROP];
  return typeof v === "string" && isStrategy(v) ? v : null;
}
