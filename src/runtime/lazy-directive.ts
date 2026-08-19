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

/** When a `client:*` island hydrates. `load` is eager-but-per-island. */
export type HydrationStrategy = "load" | "idle" | "visible" | "interaction";

/** The valid strategy names, in directive form. */
export const HYDRATION_STRATEGIES: readonly HydrationStrategy[] = [
  "load",
  "idle",
  "visible",
  "interaction",
];

/** The prop key the server stamps a resolved strategy under on a Flight boundary. */
export const STRATEGY_PROP = "__dnxHydrate";

const PREFIX = "client:";

function isStrategy(s: string): s is HydrationStrategy {
  return (HYDRATION_STRATEGIES as readonly string[]).includes(s);
}

/**
 * Extract a `client:*` directive from an island's props. Returns the resolved
 * strategy (or null if none/invalid) and a copy of the props with every
 * `client:*` key removed, so the marker never reaches the real DOM.
 *
 * @param props The island element's props.
 * @param moduleDefault A `hydrate` export from the island's own module, if any.
 */
export function parseStrategy(
  props: Record<string, unknown>,
  moduleDefault?: unknown,
): { strategy: HydrationStrategy | null; rest: Record<string, unknown> } {
  let strategy: HydrationStrategy | null = null;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith(PREFIX)) {
      // `client:visible` (boolean-shorthand true) or `client="visible"`-style value.
      const name = key.slice(PREFIX.length);
      if (name && isStrategy(name) && value !== false) {
        strategy = name; // usage-site prop wins
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
  return { strategy, rest };
}

/** Read a strategy the server stamped under {@link STRATEGY_PROP}, if valid. */
export function readStampedStrategy(props: Record<string, unknown>): HydrationStrategy | null {
  const v = props[STRATEGY_PROP];
  return typeof v === "string" && isStrategy(v) ? v : null;
}
