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
}

/** Compose a client-reference id from a module client id and an export name. */
export function clientRefId(clientId: string, name: string): string {
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
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === "function" && !(value as { [CLIENT_REF]?: unknown })[CLIENT_REF]) {
      const info: ClientRefInfo = { clientId, name, id: clientRefId(clientId, name) };
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
  if (typeof value !== "function") return null;
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
  await Promise.all(
    [...clients].map(async ([clientId, ref]) => {
      if (taggedClients.has(clientId)) return;
      const mod = await import(ref.url);
      tagClientExports(mod as Record<string, unknown>, clientId);
      taggedClients.add(clientId);
    }),
  );
}
