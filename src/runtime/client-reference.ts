// Client references — the server side of the `"use client"` boundary.
//
// A `"use client"` module is imported on the server (so its exports can be SSR'd
// to HTML for first paint) but must NOT be re-invoked as a server component when
// producing the Flight payload: in Flight it appears as a *reference* (id) that
// the browser resolves to the real client component. This mirrors the server-
// action pattern (`runtime/server-action.ts`): tag a value with a stable id, and
// carry only the id across the boundary.
//
// The build's boundary manifest assigns each client module a `clientId`; each
// exported component is tagged `clientId#exportName`.

import { isComponentType } from "./react-brands.ts";

/** Symbol under which a client-reference id is stored on a tagged component. */
export const CLIENT_REF: unique symbol = Symbol.for("denext.clientRef");

/** The identifying info carried by a tagged client-component reference. */
export interface ClientRefInfo {
  /** The module's stable client id (`c_<hash>`). */
  clientId: string;
  /** The exported symbol name. */
  name: string;
  /** The full reference id (`clientId#name`) used in the Flight payload. */
  id: string;
  /**
   * The island module's `export const hydrate` value, if any — a per-component
   * hydration-strategy default the renderer feeds to `parseStrategy` as the
   * `moduleDefault` (a usage-site `client:*` still wins). Left `undefined` when
   * the module declares no such export.
   */
  moduleHydrate?: unknown;
}

/** Compose a client-reference id from a module client id and an export name. */
function clientRefId(clientId: string, name: string): string {
  return `${clientId}#${name}`;
}

/**
 * Tag every exported function of a `"use client"` module so the Flight renderer
 * recognizes them as client references instead of calling them as server
 * components. Non-function exports are ignored.
 *
 * @param mod The imported module namespace object.
 * @param clientId The module's stable client id.
 */
export function tagClientExports(mod: Record<string, unknown>, clientId: string): void {
  // A module-level `export const hydrate = "visible"` is the per-component default
  // strategy for every island this module exports (a usage-site `client:*` still
  // overrides it). Read it once; `parseStrategy` validates the value.
  const moduleHydrate = (mod as { hydrate?: unknown }).hydrate;
  for (const [name, value] of Object.entries(mod)) {
    // Functions AND React's non-callable `memo()` / `forwardRef()` element objects — a
    // component library's `"use client"` module (radix's Dialog.Content) exports the latter,
    // and an untagged one is invoked as a server component: outside its provider, at the
    // wrong time ("`DialogContent` must be used within `Dialog`").
    if (isComponentType(value) && !(value as { [CLIENT_REF]?: unknown })[CLIENT_REF]) {
      const info: ClientRefInfo = {
        clientId,
        name,
        id: clientRefId(clientId, name),
        moduleHydrate,
      };
      Object.defineProperty(value, CLIENT_REF, {
        value: info,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

/**
 * If `value` is a tagged client-component reference, return its info; else null.
 *
 * @param value A candidate VNode `type` (component function).
 */
export function clientRefOf(value: unknown): ClientRefInfo | null {
  if (typeof value !== "function" && (typeof value !== "object" || value === null)) return null;
  const info = (value as { [CLIENT_REF]?: ClientRefInfo })[CLIENT_REF];
  return info ?? null;
}

// Client ids already imported + tagged this process, so repeat renders don't
// re-import. ES modules are singletons, so tagging the imported instance also
// tags the very functions a server page imports transitively.
const taggedClients = new Set<string>();

/**
 * Import each `"use client"` module and tag its exports as client references, so
 * the Flight renderer emits references for them (rather than invoking them). Safe
 * to call repeatedly; each module is imported at most once per process.
 *
 * @param clients Map of client id → `{ url }` (the boundary manifest's clients).
 */
export async function tagClientModules(
  clients: Iterable<[string, { url: string }]>,
): Promise<void> {
  const pending = [...clients].filter(([clientId]) => !taggedClients.has(clientId));
  if (pending.length === 0) return;
  const barrel = pending.length > BARREL_MIN
    ? await importViaBarrel(pending.map(([, ref]) => ref.url))
    : null;
  await Promise.all(
    pending.map(async ([clientId, ref], i) => {
      const mod = barrel ? barrel[i] : await import(ref.url);
      tagClientExports(mod as Record<string, unknown>, clientId);
      taggedClients.add(clientId);
    }),
  );
}

/** Above this many islands, {@link tagClientModules} imports through one barrel module. */
const BARREL_MIN = 8;

/**
 * Import every `url` through ONE synthetic `data:` module that statically imports them
 * all — a single module-graph build. Deno re-walks the already-loaded graph for each
 * separate dynamic `import()`, so tagging a large app's islands one by one is quadratic:
 * shadcn/ui's 2,680 islands took 9 minutes on the first request, seconds as a barrel.
 * Returns the namespaces in `urls` order, or `null` when the barrel fails to load (the
 * caller then imports individually, so a broken island surfaces through its own import).
 */
async function importViaBarrel(urls: string[]): Promise<unknown[] | null> {
  const src = urls.map((u, i) => `import * as m${i} from ${JSON.stringify(u)};`).join("\n") +
    `\nexport default [${urls.map((_, i) => `m${i}`).join(",")}];`;
  try {
    const mod = await import("data:text/javascript," + encodeURIComponent(src));
    return mod.default as unknown[];
  } catch {
    return null;
  }
}
