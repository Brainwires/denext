// `/plugins` — third-party plugin discovery on JSR: the search box (a GET form, so it answers under
// `--read-only` and with JavaScript disabled), its results, and the resolution an `op=add-jsr`
// goes through before the plugin manager's ordinary add path takes over.
//
// Everything the registry sends is untrusted text: `src/ui/jsr.ts` normalises it and the renderer
// escapes it. The browser supplies only a package name and an export name — the name must pass
// JSR's own rules and the export must be a JavaScript identifier, both checked before any request
// or subprocess — and the version is read from the registry in the same request, never from the
// form. A third-party plugin is wired as a zero-argument `factory()` call: it publishes no options
// schema here, so it gets no options sub-panel.

import { type PluginNames, resolvePluginNames } from "../../build/plugin-install.ts";
import { Fragment, h } from "../../jsx/jsx-runtime.ts";
import type { VNode } from "../../jsx/types.ts";
import { Input, Note, OpForm } from "../components.ts";
import type { UiContext } from "../html.ts";
import {
  fetchJsrMeta,
  isJsrSpec,
  jsrAvailable,
  type JsrHit,
  type JsrSearchResult,
  searchJsr,
} from "../jsr.ts";

/** The registry calls this panel makes. */
interface JsrClient {
  /** Package search. */
  readonly search: typeof searchJsr;
  /** One package's latest version. */
  readonly meta: typeof fetchJsrMeta;
}

/** The live registry client. */
const LIVE: JsrClient = { search: searchJsr, meta: fetchJsrMeta };

/** The client every search and every `add-jsr` goes through. */
let client: JsrClient = LIVE;

/**
 * Swap the JSR client this panel uses.
 *
 * @internal Test seam only: the suite stubs the registry so it never reaches the network, and
 * counts the calls. Passing nothing restores the live client.
 * @param stub The replacement calls (any left out stay live), or `undefined` to restore.
 */
export function setJsrClient(stub?: Partial<JsrClient>): void {
  client = { ...LIVE, ...stub };
}

/** How many hits one search shows. */
const SEARCH_LIMIT = 20;

/** A JavaScript identifier — the only shape a factory export name may take. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Words an import binding may not be (the injected `import { … }` would not parse). */
const RESERVED: ReadonlySet<string> = new Set(
  ("await break case catch class const continue debugger default delete do else enum export " +
    "extends false finally for function if implements import in instanceof interface let new " +
    "null package private protected public return static super switch this throw true try " +
    "typeof var void while with yield").split(" "),
);

/** Why the box has no search behind it. */
const UNAVAILABLE =
  "JSR search is unavailable — the UI runs --offline, or has no net permission for " +
  "api.jsr.io (to search) or jsr.io (to add a package).";

/** What the discovery box renders from. */
export interface Discovery {
  /** JSR may be queried (not `--offline`, and net permission is already granted). */
  readonly available: boolean;
  /** The submitted search text (`""` when there is none). */
  readonly query: string;
  /** The search outcome, when a query ran. */
  readonly result?: JsrSearchResult;
}

/**
 * The discovery state for one request: whether JSR may be queried and, for a `GET` carrying
 * `?q=`, the search itself. Nothing is fetched when the UI is offline or lacks net permission.
 *
 * @param ctx The request context (`offline`, the URL, the shutdown signal).
 * @returns Availability, the query, and the search outcome when one ran.
 */
export async function discover(ctx: UiContext): Promise<Discovery> {
  const available = await jsrAvailable(ctx, "search");
  const query = ctx.method === "GET" ? (ctx.url.searchParams.get("q") ?? "").trim() : "";
  if (!available || query === "") return { available, query };
  const result = await client.search(query, { limit: SEARCH_LIMIT, signal: ctx.signal });
  return { available, query, result };
}

/**
 * The machine view of discovery, merged into the `/api/plugins` payload.
 *
 * @param discovery The request's discovery state.
 * @returns `{ jsr: { available, query, search? } }`.
 */
export function discoveryPayload(discovery: Discovery): Record<string, unknown> {
  const { available, query, result } = discovery;
  return { jsr: { available, query, ...(result ? { search: result } : {}) } };
}

// ── `op=add-jsr` ─────────────────────────────────────────────────────────────

/** A third-party package resolved for an add: its install names and the fields that re-post it. */
interface JsrAdd {
  /** `@scope/name`. */
  readonly spec: string;
  /** The `deno add` spec (caret-pinned to the registry's latest), import and factory call. */
  readonly names: PluginNames;
  /** The hidden fields the confirm form re-posts (never the version). */
  readonly fields: Readonly<Record<string, string>>;
}

/** An `op=add-jsr` request, resolved — or refused with the status to answer. */
type JsrAddResolution =
  | { readonly ok: true; readonly add: JsrAdd }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** A refusal in the {@linkcode JsrAddResolution} shape. */
function refused(status: number, reason: string): JsrAddResolution {
  return { ok: false, status, reason };
}

/** The factory export a package is wired in as when the form names none (camelCased name). */
function defaultExport(spec: string): string {
  return resolvePluginNames(spec).factory;
}

/** Why `name` cannot be an import binding, or `null` when it can. */
function badExport(name: string): string | null {
  if (!IDENTIFIER.test(name)) return `${JSON.stringify(name.slice(0, 80))} is not an identifier`;
  return RESERVED.has(name) ? `"${name}" is a reserved word` : null;
}

/**
 * Resolve an `op=add-jsr` request: validate the package name and the factory export (both
 * before any request or subprocess), then read the package's latest version from JSR in this
 * same request. The browser never supplies the version.
 *
 * @param ctx The request context (`offline`, the shutdown signal).
 * @param spec The posted `@scope/name`.
 * @param exportName The posted factory export, or `""` for the camelCased package name.
 * @returns The install names and confirm fields, or a `400`/`503`/`502` refusal.
 */
export async function resolveJsrAdd(
  ctx: UiContext,
  spec: string,
  exportName: string,
): Promise<JsrAddResolution> {
  if (!isJsrSpec(spec)) {
    return refused(400, `not a JSR package name: ${JSON.stringify(spec.slice(0, 80))}`);
  }
  const factory = exportName === "" ? defaultExport(spec) : exportName;
  const bad = badExport(factory);
  if (bad !== null) return refused(400, `bad factory export: ${bad}`);
  if (!await jsrAvailable(ctx, "registry")) return refused(503, UNAVAILABLE);
  const [scope, name] = spec.slice(1).split("/");
  const meta = await client.meta(scope, name, { signal: ctx.signal });
  if (!meta.ok) return refused(502, `JSR lookup for ${spec} failed: ${meta.reason}`);
  const names = resolvePluginNames(`jsr:${spec}@^${meta.latest}`, { export: factory });
  return { ok: true, add: { spec, names, fields: { spec, export: factory } } };
}

// ── the views ────────────────────────────────────────────────────────────────

/**
 * The discovery section of the Plugins panel: the search box, why it is disabled (when it is),
 * and the results with an Add form each.
 *
 * @param props `ctx`: the request context; `discovery`: its discovery state.
 * @returns The section's heading, box and results.
 */
export function JsrDiscovery(
  { ctx, discovery }: { readonly ctx: UiContext; readonly discovery: Discovery },
): VNode {
  return h(
    Fragment,
    null,
    h("h2", { id: "jsr" }, "Find a plugin on JSR"),
    h(
      "p",
      { class: "lead" },
      "A third-party plugin is wired as a zero-argument ",
      h("code", null, "factory()"),
      " call. It publishes no options schema here, so it has no options panel — set its options in ",
      h("code", null, "denext.config.ts"),
      ".",
    ),
    h(SearchBox, { discovery }),
    discovery.available ? null : h(Note, null, UNAVAILABLE),
    discovery.result ? h(SearchResults, { ctx, result: discovery.result }) : null,
  );
}

/** The search box — a GET form, disabled when JSR may not be queried. */
function SearchBox({ discovery }: { readonly discovery: Discovery }): VNode {
  const off = !discovery.available;
  return h(
    "form",
    { method: "get", action: "/plugins", class: "row" },
    h(Input, {
      type: "search",
      name: "q",
      value: discovery.query,
      placeholder: "Search JSR packages",
      ariaLabel: "Search JSR packages",
      disabled: off,
    }),
    " ",
    h("button", { type: "submit", disabled: off }, "Search"),
  );
}

/** The hits, or why there are none. */
function SearchResults(
  { ctx, result }: { readonly ctx: UiContext; readonly result: JsrSearchResult },
): VNode {
  if (!result.ok) return h(Note, null, `JSR search failed: ${result.reason}`);
  if (result.hits.length === 0) return h(Note, null, "No JSR package matched.");
  return h(
    "div",
    { class: "cards" },
    result.hits.map((hit) => h(HitCard, { key: `${hit.scope}/${hit.name}`, ctx, hit })),
  );
}

/** One hit: its name, version, description, archived badge, and an Add form. */
function HitCard({ ctx, hit }: { readonly ctx: UiContext; readonly hit: JsrHit }): VNode {
  const spec = `@${hit.scope}/${hit.name}`;
  return h(
    "article",
    { class: "card", id: `jsr:${spec}` },
    h("strong", null, spec),
    " ",
    h("span", { class: "badge" }, hit.version),
    " ",
    hit.archived ? h("span", { class: "badge" }, "archived") : null,
    " ",
    h("span", null, hit.description || "No description."),
    h(OpForm, {
      csrf: ctx.csrf,
      action: "/plugins",
      label: "Add",
      fields: { op: "add-jsr", spec },
      disabled: ctx.readOnly,
      extra: h(
        "label",
        null,
        "Factory export ",
        h(Input, { name: "export", value: defaultExport(spec), autocomplete: "off" }),
      ),
    }),
  );
}
