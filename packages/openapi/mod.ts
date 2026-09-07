/**
 * `@denext/openapi` — an OpenAPI 3.1 document and a docs page for a denext app, derived
 * from the `defineApi` definitions its route handlers already carry. Zero config: add the
 * plugin and the app gets a live `/openapi.json` and `/docs`.
 *
 * ```ts
 * // denext.config.ts
 * import { openapi } from "@denext/openapi";
 * export default { plugins: [openapi({ info: { title: "Todos", version: "1.0.0" } })] };
 * ```
 *
 * What it reads: each route module's exported method handlers; for a `defineApi` handler,
 * its `summary` / `description` / `params` / `query` / `body` / `response` schemas and
 * `errors` (through `apiDefinitionOf`, the `@denext/denext/plugin-kit` seam). Schemas
 * become JSON Schema through the Standard JSON Schema interface (Zod ≥ 4.2, ArkType,
 * Valibot's `toStandardJsonSchema`), TypeBox's native JSON Schema, a `toJsonSchema()`
 * method, or your own `toJsonSchema` converter — else `{}` plus a lint warning.
 *
 * Three outputs, one document:
 * - **Live:** `GET /openapi.json` and `GET /docs` (a request handler — core routes win, so
 *   it never shadows an app page).
 * - **Build:** `denext build` writes `openapi.json` into the output directory.
 * - **CLI:** `denext openapi emit | diff <file> | lint` for CI.
 *
 * @module
 */

import type { ApiRoute, DenextPlugin, PluginContext, RouteManifest } from "@denext/denext/server";
import { scanRoutes } from "@denext/denext/server";
import { join } from "@std/path";
import { createOpenapiCommand } from "./command.ts";
import { DOCS_CSS, type DocsUi, renderDocsHtml } from "./docs-ui.ts";
import {
  buildOpenApi,
  type OpenApiBuild,
  type OpenApiInfo,
  type OpenApiServer,
  type SchemaConverter,
} from "./spec.ts";

export { API_ERROR_SCHEMA, buildOpenApi, diffSpecs, pathVariants, toJsonSchema } from "./spec.ts";
export type {
  BuildOpenApiOptions,
  JsonSchema,
  OpenApiBuild,
  OpenApiDocument,
  OpenApiInfo,
  OpenApiOperation,
  OpenApiServer,
  OpenApiWarning,
  OpenApiWarningCode,
  RouteModuleLoader,
  SchemaConversion,
  SchemaConverter,
  SchemaSide,
  SchemaSource,
  SpecChange,
} from "./spec.ts";
export { DOCS_CDN, DOCS_CSS, renderDocsHtml, renderSchema } from "./docs-ui.ts";
export type { DocsHtmlOptions, DocsUi } from "./docs-ui.ts";
export { createOpenapiCommand, formatWarning } from "./command.ts";
export type { OpenapiCommandIo } from "./command.ts";

// The denext types this package's public API references, and their transitively
// referenced members, re-exported so the generated docs are self-contained
// (`deno doc --lint`) — the same list `@denext/htmx` ships. Type-only.
export { Fragment as FRAGMENT } from "@denext/denext";
export type {
  ApiBatchConfig,
  ApiDefinition,
  ApiRoute,
  CacheConfig,
  CachedPage,
  CacheEntryTiming,
  CacheStore,
  Component,
  CspSetting,
  DataEntry,
  DenextConfig,
  DenextPlugin,
  Directive,
  ErrorSpec,
  ExperimentalConfig,
  FlightActionRef,
  FlightBigInt,
  FlightBoundary,
  FlightChannelRef,
  FlightClient,
  FlightDate,
  FlightEventHandler,
  FlightHost,
  FlightMap,
  FlightNode,
  FlightNonFinite,
  FlightPrimitive,
  FlightProps,
  FlightSet,
  FlightUrl,
  FlightValue,
  HeaderRule,
  HstsConfig,
  HydrationStrategy,
  I18nConfig,
  I18nDomain,
  ImagesConfig,
  Intercept,
  IslandPayload,
  Key,
  LiveConfig,
  LiveConnectionContext,
  LiveLimits,
  LiveSubscriptionRequest,
  LocalPattern,
  MdxConfig,
  Messages,
  ModuleLoader,
  PageRoute,
  PluginBuildContext,
  PluginBuildStep,
  PluginContext,
  PluginMode,
  PluginRequestHandler,
  PluginTeardown,
  RedirectRule,
  RemotePattern,
  RewriteRule,
  RouteCsp,
  RouteManifest,
  RouteSynthesizer,
  Segment,
  SegmentKind,
  SegmentLevel,
  SlotRoutes,
  SpaConfig,
  SpaDesktopConfig,
  SpaProxyConfig,
  StandardIssue,
  StandardResult,
  StandardSchemaV1,
  TailwindConfig,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "@denext/denext/server";

/** Options for {@linkcode openapi}. */
export interface OpenApiOptions {
  /** Where the document is served (default `/openapi.json`, app-relative: `basePath` is already stripped). */
  path?: string;
  /** Where the docs page is served (default `/docs`, app-relative); `false` disables it. */
  docs?: string | false;
  /**
   * The docs renderer: `builtin` (server-rendered, no JavaScript, strict-CSP clean — the
   * default), `scalar` or `swagger` (interactive, loaded from a CDN).
   */
  ui?: DocsUi;
  /** Override the CDN URL for `scalar` (script URL) or `swagger` (dist base URL). */
  cdn?: string;
  /** The document's `info` (defaults: the project directory's name, version `0.0.0`). */
  info?: Partial<OpenApiInfo>;
  /** The document's `servers`. */
  servers?: OpenApiServer[];
  /** Describe validators the built-in detection cannot (consulted first). */
  toJsonSchema?: SchemaConverter;
  /** Keep a route in the document (default: every API route). */
  include?: (route: ApiRoute) => boolean;
  /** Tag an operation (default: the first path segment after `/api`). */
  tags?: (route: ApiRoute) => string[];
  /**
   * When the live endpoints are served. `"always"` (default) serves `/openapi.json` and
   * `/docs` in every mode — the zero-config default, since a document describing your own API
   * is usually fine to expose. `"dev"` serves them only under `denext dev` (like GraphiQL),
   * so production reveals no route/schema map. Either way {@link authorize} still applies.
   */
  expose?: "always" | "dev";
  /**
   * Gate the live endpoints. Return `false` to hide them from a request (the app's own
   * 404 answers — no distinguishable "forbidden"). Runs after {@link expose}. Default: open.
   */
  authorize?: (request: Request) => boolean | Promise<boolean>;
  /**
   * The file `denext build` writes into the output directory (default `openapi.json`);
   * `false` skips the build step.
   */
  outFile?: string | false;
}

/**
 * Create the OpenAPI plugin. Place it in your `denext.config.ts` `plugins`.
 *
 * @param options Endpoint paths, docs renderer, document metadata, schema conversion.
 */
export function openapi(options: OpenApiOptions = {}): DenextPlugin {
  return {
    name: "@denext/openapi",
    setup(ctx: PluginContext) {
      // The pipeline strips `basePath` before the plugin seam: match app-relative paths, but
      // DESCRIBE the public ones (the document's paths carry the prefix a client must send).
      const basePath = (ctx.config.basePath ?? "").replace(/\/$/, "");
      const specPath = options.path ?? "/openapi.json";
      const docsPath = options.docs === false ? null : options.docs ?? "/docs";
      const ui = options.ui ?? "builtin";
      const exposed = (options.expose ?? "always") === "always" || ctx.mode === "dev";
      const build = specBuilder(ctx, options, basePath);

      const routes: Endpoints = {
        specPath,
        docsPath,
        ui,
        basePath,
        build,
        authorize: options.authorize,
        cdn: options.cdn,
      };
      ctx.addRequestHandler((request) => exposed ? serveDocs(request, routes) : null);

      const outFile = options.outFile ?? "openapi.json";
      if (outFile !== false) {
        ctx.addBuildStep(async ({ outDir }) => {
          const result = await build();
          const dest = join(outDir, outFile);
          await Deno.mkdir(join(dest, ".."), { recursive: true });
          await Deno.writeTextFile(dest, JSON.stringify(result.document, null, 2) + "\n");
          if (result.warnings.length) {
            console.warn(
              `[@denext/openapi] ${result.warnings.length} lint warning(s) — run \`denext openapi lint\``,
            );
          }
        });
      }

      ctx.addCommand(createOpenapiCommand(build));
    },
  };
}

/** The resolved endpoint config the request handler serves from. */
interface Endpoints {
  specPath: string;
  docsPath: string | null;
  ui: DocsUi;
  basePath: string;
  build: () => Promise<OpenApiBuild>;
  authorize?: (request: Request) => boolean | Promise<boolean>;
  cdn?: string;
}

/** Serve `/openapi.json`, `/docs` or the docs stylesheet; `null` for anything else. */
async function serveDocs(request: Request, e: Endpoints): Promise<Response | null> {
  const url = new URL(request.url);
  const isCss = e.ui === "builtin" && e.docsPath !== null && url.pathname === e.docsPath + ".css";
  const wants = url.pathname === e.specPath || url.pathname === e.docsPath || isCss;
  if (!wants || (request.method !== "GET" && request.method !== "HEAD")) return null;
  if (e.authorize && !(await e.authorize(request))) return null;
  if (url.pathname === e.specPath) return specResponse(request, await e.build());
  if (url.pathname === e.docsPath) return docsPageResponse(request, e);
  return new Response(DOCS_CSS, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

/** The rendered docs page for the configured renderer. */
async function docsPageResponse(request: Request, e: Endpoints): Promise<Response> {
  const html = renderDocsHtml((await e.build()).document, {
    specUrl: e.basePath + e.specPath,
    ui: e.ui,
    cdn: e.cdn,
    styleUrl: e.ui === "builtin" ? e.basePath + e.docsPath + ".css" : undefined,
  });
  return new Response(request.method === "HEAD" ? null : html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

/**
 * The spec builder for one project: sees every scanned manifest through the
 * route-synthesizer seam (so dev's per-request rescan is honored for free, and prod builds
 * once), falls back to scanning `appDir` when no scan has happened yet (the CLI verb), and
 * memoizes per manifest object.
 */
function specBuilder(
  ctx: PluginContext,
  options: OpenApiOptions,
  basePath: string,
): () => Promise<OpenApiBuild> {
  let manifest: RouteManifest | null = null;
  let cached: { manifest: RouteManifest; result: OpenApiBuild } | null = null;
  ctx.addRouteSynthesizer((m) => {
    manifest = m;
  });
  const title = ctx.projectRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "API";
  return async () => {
    const m = manifest ?? await scanRoutes(ctx.appDir);
    if (cached?.manifest === m) return cached.result;
    const result = await buildOpenApi({
      manifest: m,
      load: ctx.load,
      info: { title, version: "0.0.0", ...options.info },
      servers: options.servers,
      basePath,
      toJsonSchema: options.toJsonSchema,
      include: options.include,
      tags: options.tags,
    });
    cached = { manifest: m, result };
    return result;
  };
}

/** The serialized document + its ETag, computed once per build result (a WeakMap: no leak). */
const serialized = new WeakMap<OpenApiBuild, Promise<{ body: string; etag: string }>>();

function serialize(result: OpenApiBuild): Promise<{ body: string; etag: string }> {
  let p = serialized.get(result);
  if (!p) {
    p = (async () => {
      const body = JSON.stringify(result.document, null, 2) + "\n";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const hex = [...new Uint8Array(digest).slice(0, 12)]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      return { body, etag: `"${hex}"` };
    })();
    serialized.set(result, p);
  }
  return p;
}

async function specResponse(request: Request, result: OpenApiBuild): Promise<Response> {
  const { body, etag } = await serialize(result);
  const headers = {
    "cache-control": "no-cache",
    etag,
    "x-denext-openapi-warnings": String(result.warnings.length),
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}
