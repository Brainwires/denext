// The plugin's options, checked when `tanstackStart(options)` is called: each option against the
// shape TanStack Start's own plugin accepts for it (`@tanstack/start-plugin-core`'s schema —
// `router`, `importProtection`, `prerender`, `pages`) or the plugin's own (`srcDirectory`,
// `maxBodyBytes`, …). A bad value throws the field-scoped error `denext.config` validation throws
// (`invalid tanstackStart() options: \`importProtection.client.files[0]\` must be …`), so a typo
// in a security rule fails at config load instead of quietly turning the rule off. An unknown key
// is refused too, with the closest known one suggested.

/** The name the errors carry. */
const NAME = "tanstackStart() options";

const fail = (field: string, msg: string): never => {
  throw new Error(`invalid ${NAME}: \`${field}\` ${msg}`);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RegExp);

const at = (field: string, key: string) => field ? `${field}.${key}` : key;

/** The known key closest to `key` (an edit distance of at most 2, or a prefix), if any. */
function closest(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  const prefixed = lower.length >= 4 &&
    known.find((k) => k.toLowerCase().startsWith(lower) || lower.startsWith(k.toLowerCase()));
  if (prefixed) return prefixed;
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of known) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const swap = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, swap);
    }
    prev = row;
  }
  return prev[b.length];
}

/** Keys Start accepts that the plugin cannot honour, and why (refused by name, not as typos). */
type Refused = Record<string, string>;

/** An object whose keys are all known; `undefined` passes (the option is unset). */
function object(
  field: string,
  v: unknown,
  known: readonly string[],
  refused: Refused = {},
): v is Record<string, unknown> {
  if (v === undefined) return false;
  if (!isPlainObject(v)) fail(field || NAME, "must be an object");
  for (const key of Object.keys(v as object)) {
    if (known.includes(key)) continue;
    if (key in refused) fail(at(field, key), refused[key]);
    const hint = closest(key, known);
    fail(at(field, key), `is not an option${hint ? ` (did you mean \`${hint}\`?)` : ""}`);
  }
  return true;
}

function boolean(field: string, v: unknown): void {
  if (v !== undefined && typeof v !== "boolean") fail(field, "must be a boolean");
}

function string(field: string, v: unknown, nonEmpty = false): void {
  if (v === undefined) return;
  if (typeof v !== "string" || (nonEmpty && v === "")) {
    fail(field, nonEmpty ? "must be a non-empty string" : "must be a string");
  }
}

function fn(field: string, v: unknown): void {
  if (v !== undefined && typeof v !== "function") fail(field, "must be a function");
}

function number(field: string, v: unknown, opts: { min?: number; int?: boolean } = {}): void {
  if (v === undefined) return;
  const min = opts.min ?? 0;
  const ok = typeof v === "number" && Number.isFinite(v) && v >= min &&
    (!opts.int || Number.isInteger(v));
  if (!ok) fail(field, `must be a finite ${opts.int ? "integer" : "number"} >= ${min}`);
}

function oneOf(field: string, v: unknown, allowed: readonly string[]): void {
  if (v !== undefined && !allowed.includes(v as string)) {
    fail(field, `must be one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
}

function arrayOf(field: string, v: unknown, item: (field: string, v: unknown) => void): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) fail(field, "must be an array");
  (v as unknown[]).forEach((el, i) => item(`${field}[${i}]`, el));
}

/** Start's `patternSchema`: a string (a glob, or a literal) or a RegExp. */
function pattern(field: string, v: unknown): void {
  if (typeof v !== "string" && !(v instanceof RegExp)) {
    fail(field, "must be a string (a glob) or a RegExp");
  }
}

const patterns = (field: string, v: unknown) => arrayOf(field, v, pattern);

const BEHAVIORS = ["error", "mock"] as const;

/** Start's `importProtectionEnvRulesSchema`. */
function envRules(field: string, v: unknown): void {
  if (!object(field, v, ["specifiers", "files", "excludeFiles"])) return;
  patterns(`${field}.specifiers`, v.specifiers);
  patterns(`${field}.files`, v.files);
  patterns(`${field}.excludeFiles`, v.excludeFiles);
}

/** Start's `behavior`: `"error"`, `"mock"` or `{ dev?, build? }`. */
function behavior(field: string, v: unknown): void {
  if (isPlainObject(v)) {
    object(field, v, ["dev", "build"]);
    oneOf(`${field}.dev`, v.dev, BEHAVIORS);
    oneOf(`${field}.build`, v.build, BEHAVIORS);
  } else if (v !== undefined && !BEHAVIORS.includes(v as "error")) {
    fail(field, `must be "error", "mock" or { dev?, build? }`);
  }
}

const IMPORT_PROTECTION_KEYS = [
  "enabled",
  "behavior",
  "mockAccess",
  "onViolation",
  "include",
  "exclude",
  "client",
  "server",
  "ignoreImporters",
  "maxTraceDepth",
  "log",
];

/** Start's `importProtectionOptionsSchema`. */
function importProtection(field: string, v: unknown): void {
  if (!object(field, v, IMPORT_PROTECTION_KEYS)) return;
  boolean(`${field}.enabled`, v.enabled);
  behavior(`${field}.behavior`, v.behavior);
  oneOf(`${field}.mockAccess`, v.mockAccess, ["error", "warn", "off"]);
  fn(`${field}.onViolation`, v.onViolation);
  patterns(`${field}.include`, v.include);
  patterns(`${field}.exclude`, v.exclude);
  patterns(`${field}.ignoreImporters`, v.ignoreImporters);
  envRules(`${field}.client`, v.client);
  envRules(`${field}.server`, v.server);
  number(`${field}.maxTraceDepth`, v.maxTraceDepth, { int: true });
  oneOf(`${field}.log`, v.log, ["once", "always"]);
}

const PAGE_PRERENDER_KEYS = [
  "enabled",
  "outputPath",
  "autoSubfolderIndex",
  "crawlLinks",
  "retryCount",
  "retryDelay",
  "onSuccess",
  "headers",
];

/** The fields of Start's `pagePrerenderOptionsSchema` (on a page, and in `prerender`). */
function pagePrerenderFields(field: string, v: Record<string, unknown>): void {
  boolean(`${field}.enabled`, v.enabled);
  string(`${field}.outputPath`, v.outputPath, true);
  boolean(`${field}.autoSubfolderIndex`, v.autoSubfolderIndex);
  boolean(`${field}.crawlLinks`, v.crawlLinks);
  number(`${field}.retryCount`, v.retryCount, { int: true });
  number(`${field}.retryDelay`, v.retryDelay);
  fn(`${field}.onSuccess`, v.onSuccess);
  if (v.headers === undefined) return;
  if (!isPlainObject(v.headers)) fail(`${field}.headers`, "must be an object of strings");
  for (const [name, value] of Object.entries(v.headers as object)) {
    string(`${field}.headers.${name}`, value);
  }
}

/** Start's `prerender` (its own fields and a page's prerender options). */
function prerender(field: string, v: unknown): void {
  const keys = [
    "concurrency",
    "filter",
    "failOnError",
    "autoStaticPathsDiscovery",
    "maxRedirects",
    ...PAGE_PRERENDER_KEYS,
  ];
  if (!object(field, v, keys)) return;
  number(`${field}.concurrency`, v.concurrency, { min: 1, int: true });
  fn(`${field}.filter`, v.filter);
  boolean(`${field}.failOnError`, v.failOnError);
  boolean(`${field}.autoStaticPathsDiscovery`, v.autoStaticPathsDiscovery);
  number(`${field}.maxRedirects`, v.maxRedirects, { int: true });
  pagePrerenderFields(field, v);
}

/** One of Start's `pages` (its `pageSchema`). */
function page(field: string, v: unknown): void {
  if (!isPlainObject(v)) fail(field, "must be an object");
  object(field, v, ["path", "prerender", "sitemap", "fromCrawl"]);
  const p = v as Record<string, unknown>;
  if (typeof p.path !== "string" || !p.path.startsWith("/")) {
    fail(`${field}.path`, 'must be a path starting with "/"');
  }
  if (object(`${field}.prerender`, p.prerender, PAGE_PRERENDER_KEYS)) {
    pagePrerenderFields(`${field}.prerender`, p.prerender);
  }
  if (p.sitemap !== undefined && !isPlainObject(p.sitemap)) {
    fail(`${field}.sitemap`, "must be an object");
  }
  boolean(`${field}.fromCrawl`, p.fromCrawl);
}

/**
 * The route generator's options Start's `router` takes (`@tanstack/router-generator`'s
 * `configSchema`, less the `target` and `autoCodeSplitting` Start leaves out), and the type each
 * must have (`"any"`: the generator checks it).
 */
const GENERATOR_KEYS: Record<string, "string" | "boolean" | "any"> = {
  virtualRouteConfig: "any",
  routeFilePrefix: "string",
  routeFileIgnorePrefix: "string",
  routeFileIgnorePattern: "string",
  routesDirectory: "string",
  quoteStyle: "any",
  semicolons: "boolean",
  disableLogging: "boolean",
  routeTreeFileHeader: "any",
  indexToken: "any",
  routeToken: "any",
  pathParamsAllowedCharacters: "any",
  generatedRouteTree: "string",
  disableTypes: "boolean",
  addExtensions: "any",
  enableRouteTreeFormatting: "boolean",
  routeTreeFileFooter: "any",
  customScaffolding: "any",
  experimental: "any",
  plugins: "any",
  tmpDir: "string",
  importRoutesUsingAbsolutePaths: "boolean",
};

/** The parts of Start's `router` the plugin cannot honour. */
const ROUTER_REFUSED: Refused = {
  target: "is not an option: the plugin builds a React app (Start's own plugin omits `target`)",
  autoCodeSplitting: "is not an option: Start's own plugin omits it, and denext splits the " +
    "browser bundle itself",
};

/** Start's `router`: `{ entry?, basepath? }` and the generator's options. */
function router(field: string, v: unknown): void {
  if (typeof v === "string") return string(field, v, true);
  if (!object(field, v, ["entry", "basepath", ...Object.keys(GENERATOR_KEYS)], ROUTER_REFUSED)) {
    return;
  }
  string(`${field}.entry`, v.entry, true);
  string(`${field}.basepath`, v.basepath);
  for (const [key, type] of Object.entries(GENERATOR_KEYS)) {
    if (type === "string") string(`${field}.${key}`, v[key], true);
    if (type === "boolean") boolean(`${field}.${key}`, v[key]);
  }
  quoteStyle(`${field}.quoteStyle`, v.quoteStyle);
  addExtensions(`${field}.addExtensions`, v.addExtensions);
  if (v.plugins !== undefined && !Array.isArray(v.plugins)) {
    fail(`${field}.plugins`, "must be an array");
  }
}

/** The generator's `addExtensions`: `true` or an extension; never `false`. */
function addExtensions(field: string, v: unknown): void {
  if (v === false) {
    fail(field, "cannot be false: Deno resolves the route tree's imports by their file extensions");
  }
  if (v !== undefined && v !== true) string(field, v, true);
}

const quoteStyle = (field: string, v: unknown) => oneOf(field, v, ["single", "double"]);

/** The plugin's options, each key as {@link TanStackStartOptions} declares it. */
const OPTION_KEYS = [
  "srcDirectory",
  "router",
  "generateRouteTree",
  "maxBodyBytes",
  "allowedOrigins",
  "importProtection",
  "prerender",
  "pages",
];

/**
 * Check `tanstackStart()`'s options, throwing the field-scoped error `denext.config` validation
 * throws on the first bad value or unknown key.
 *
 * @param options The options as the app passed them.
 * @throws `invalid tanstackStart() options: \`<field>\` <what it must be>`.
 */
export function validateOptions(options: unknown): void {
  if (!object("", options, OPTION_KEYS)) return;
  string("srcDirectory", options.srcDirectory, true);
  router("router", options.router);
  boolean("generateRouteTree", options.generateRouteTree);
  number("maxBodyBytes", options.maxBodyBytes, { min: 1, int: true });
  arrayOf("allowedOrigins", options.allowedOrigins, (f, v) => string(f, v, true));
  importProtection("importProtection", options.importProtection);
  prerender("prerender", options.prerender);
  arrayOf("pages", options.pages, page);
}

/** Start's `router` option in its object form. */
export interface StartRouterOptions {
  /**
   * The router module, relative to `srcDirectory`; the extension may be left out (default
   * `router`, as in Start).
   */
  entry?: string;
  /**
   * The router's base path. It must match the app's `basePath` (denext serves the app under
   * that); set `basePath` in `denext.config.ts` instead.
   */
  basepath?: string;
  /**
   * `@tanstack/router-generator`'s options (`routesDirectory` and `generatedRouteTree` relative
   * to `srcDirectory`, as in Start), passed to the generator over `tsr.config.json`. `addExtensions`
   * cannot be `false`.
   */
  [generatorOption: string]: unknown;
}

/** Where the router lives and how its tree is generated, from either form of `router`. */
export interface ResolvedRouter {
  /** The router module's name under the source directory, as given (maybe extensionless). */
  entry: string;
  /** The base path the router asked for (`undefined`: none). */
  basepath?: string;
  /** The generator's inline options (everything else). */
  generator: Record<string, unknown>;
}

/**
 * Normalize the `router` option: a filename (the plugin's own form) or Start's object.
 *
 * @param router The option as given.
 */
export function resolveRouter(router: string | StartRouterOptions | undefined): ResolvedRouter {
  if (router === undefined || typeof router === "string") {
    return { entry: router ?? "router.tsx", generator: {} };
  }
  const { entry, basepath, ...generator } = router;
  return { entry: entry ?? "router", basepath, generator };
}

/** A base path as denext compares it (`/` and `""` are none; no trailing slash). */
const normalizeBasePath = (path: string | undefined) => (path ?? "").replace(/\/+$/, "");

/**
 * Refuse a `router.basepath` other than the app's `basePath`.
 *
 * @param basepath The router's base path.
 * @param appBasePath The app's `basePath` (`denext.config.ts`).
 */
export function checkBasepath(basepath: string | undefined, appBasePath: string | undefined): void {
  if (basepath === undefined) return;
  if (normalizeBasePath(basepath) === normalizeBasePath(appBasePath)) return;
  fail(
    "router.basepath",
    `is ${JSON.stringify(basepath)} but the app's basePath is ${
      JSON.stringify(appBasePath ?? "")
    }: denext serves the app under its basePath, so set \`basePath\` in denext.config.ts ` +
      "(the router follows it)",
  );
}
