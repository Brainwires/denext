/**
 * `@denext/graphql` — a GraphQL endpoint for a denext app, as a plugin: mounts a
 * {@link https://the-guild.dev/graphql/yoga-server | GraphQL Yoga} server at `/graphql`
 * (GraphiQL included in dev), bridges **subscriptions onto denext channels** so they ride the
 * app's push primitive instead of a second event bus, writes the schema SDL at build, and
 * contributes `denext graphql sdl | diff` for CI. Schema-first and code-first alike: any
 * `GraphQLSchema` works — {@link https://pothos-graphql.dev | Pothos} (code-first, typed, no
 * decorators) is the recommended builder; `createSchema` (re-exported from Yoga) covers
 * SDL + resolvers.
 *
 * ```ts
 * // denext.config.ts
 * import { graphql } from "@denext/graphql";
 * import { schema } from "./app/graphql/schema.ts";
 * export default { plugins: [graphql({ schema })] };
 * ```
 *
 * Resolvers run inside denext's request context: `cookies()`, `headers()`, `auth()` and the
 * typed API client all work in them, exactly as in a route handler.
 *
 * @module
 */

import type { DenextPlugin, PluginContext } from "@denext/denext/server";
import {
  bufferedRequest,
  readCappedBody,
  STALLED,
  TOO_LARGE,
  verifyOrigin,
} from "@denext/denext/plugin-kit";
import { dirname, isAbsolute, join, normalize, relative } from "@std/path";
import type {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLSchema,
  IntrospectionQuery,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationContext,
  VariableDefinitionNode,
} from "graphql";
import { getIntrospectionQuery, parse } from "graphql";
import {
  createGraphQLError,
  createYoga,
  type YogaInitialContext,
  type YogaServerOptions,
} from "graphql-yoga";
import { createGraphqlCommand, sdlFromIntrospection } from "./command.ts";
import { type TracedExport, traceExport } from "./trace.ts";
import { createConnectionLimiter, releaseWhenDone, resolveCaps, wantsStream } from "./limits.ts";
import {
  acceptGraphqlWs,
  type EnvelopedLike,
  type GraphqlWsDeps,
  isWebSocketUpgrade,
  operationOf,
} from "./websocket.ts";

export { createSchema } from "graphql-yoga";
export { createGraphqlCommand, diffSdl, schemaSdl } from "./command.ts";
export type { GraphqlCommandIo } from "./command.ts";
export { fromChannel } from "./subscriptions.ts";
export type { FromChannelOptions } from "./subscriptions.ts";
export type { GraphQLSchema };

// The denext types this package's public API references, and their transitively
// referenced members, re-exported so the generated docs are self-contained
// (`deno doc --lint`) — the same list `@denext/openapi` ships. Type-only.
export { Fragment as FRAGMENT } from "@denext/denext";
export type {
  ApiBatchConfig,
  CacheConfig,
  CachedPage,
  CacheEntryTiming,
  CacheStore,
  Channel,
  Component,
  CspSetting,
  DataEntry,
  DenextConfig,
  DenextPlugin,
  Directive,
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
  TailwindConfig,
  VNode,
  VNodeChild,
  VNodeChildren,
  VNodeType,
  VProps,
} from "@denext/denext/server";

/**
 * A schema, a factory for one (resolved once, on first use), or the path of the module that
 * exports it (`"./app/graphql/schema.ts"`, relative to the project root; its `schema` export, else
 * its default export, either a schema or a factory). Every form reloads on an edit under
 * `denext dev` — see {@linkcode GraphqlOptions.watch}: a schema object or factory imported into
 * `denext.config.ts` is traced to the project module that exports it (through the config's
 * relative imports) and re-imported from there.
 */
export type SchemaSource =
  | GraphQLSchema
  | (() => GraphQLSchema | Promise<GraphQLSchema>)
  | string;

/** GraphQL over WebSocket (the `graphql-ws` protocol) — see {@linkcode GraphqlOptions.websocket}. */
export interface WebSocketOptions {
  /** Close a socket that sent no `connection_init` within this many milliseconds (default 3000). */
  connectionInitTimeoutMs?: number;
  /**
   * Operations one socket may run at once — subscriptions, queries and mutations alike (default
   * 32, Live's per-connection channel cap). Past it a `subscribe` gets an `error` frame.
   */
  maxSubscriptions?: number;
}

/** What a {@linkcode GraphqlOptions.context} factory receives. */
export interface GraphqlContextInit {
  /** The incoming request. */
  request: Request;
  /** Aborts when the client disconnects — hand it to `fromChannel` in a subscription. */
  signal: AbortSignal;
}

/** Yoga options the plugin does not own (everything except schema, endpoint, GraphiQL, context). */
export type YogaPassthrough = Omit<
  YogaServerOptions<Record<string, never>, Record<string, unknown>>,
  "schema" | "graphqlEndpoint" | "graphiql" | "context"
>;

/** Tuning for the query-cost estimate (see {@linkcode GraphqlOptions.maxCost}). */
export interface CostOptions {
  /** Cost charged for each field selected (default `1`). */
  fieldCost?: number;
  /** Argument names whose integer value multiplies a field's subtree cost (default `["first", "last", "limit"]`). */
  listMultiplierArgs?: string[];
  /** Multiplier used for a pagination field when its size is a variable or absent (default `1`). */
  defaultMultiplier?: number;
}

/** Options for {@linkcode graphql}. */
export interface GraphqlOptions {
  /** The schema (Pothos `builder.toSchema()`, `createSchema({ typeDefs, resolvers })`, …). */
  schema: SchemaSource;
  /** Where the endpoint is mounted (default `/graphql`, app-relative: `basePath` is already stripped). */
  path?: string;
  /** Serve GraphiQL on a browser `GET` (default: dev only). */
  graphiql?: boolean;
  /** Answer introspection queries (default: dev only — production hides the type graph). */
  introspection?: boolean;
  /** Max request body in bytes (default 1 MiB, like a route handler; over → 413). */
  maxBodyBytes?: number;
  /**
   * Open subscription connections — WebSockets plus streamed (SSE / multipart) responses —
   * across every client; past it a new one is refused with `429` before the upgrade or the
   * response. Default: the app's `live.limits.maxConnections`, else 10 000 (Live's default).
   */
  maxConnections?: number;
  /**
   * Open subscription connections from one client address, keyed as Live keys its own:
   * `clientIpForLimits({ bucket: true })` — a trusted proxy's hop or the `rateLimitHeader`
   * address, an IPv6 client's /64, and no per-address cap for a loopback/private peer behind an
   * untrusted proxy (`rateLimitLocalAddresses` counts those). Default: the app's
   * `live.limits.maxConnectionsPerIp`, else 64 (Live's default).
   */
  maxConnectionsPerIp?: number;
  /**
   * Reject a query nested deeper than this many selection levels — a cheap guard against the
   * DoS where a small deeply-nested query over a cyclic type relation exhausts CPU/memory
   * (the body cap allows thousands of levels). Default 12; `false` disables it. Raise it for a
   * schema with legitimately deep trees.
   */
  maxDepth?: number | false;
  /**
   * Reject a query whose estimated **cost** exceeds this budget — the guard against the
   * *multiplicative* DoS a depth limit misses: `users(first: 1000) { posts(first: 1000) { … } }`
   * is shallow but fans out to a million resolver calls. Cost is estimated over the AST (no
   * schema or resolver run): each field costs {@linkcode CostOptions.fieldCost} (default 1), and
   * a field carrying a pagination argument (`first`/`last`/`limit` by default) multiplies its
   * children's cost by that integer. Default `false` (off — `maxDepth` stays the on-by-default
   * guard); set a number (a budget of ~1000 suits most apps) to enable it. The check runs at
   * execute time, so a page size passed as a **variable** (`first: $n`) is counted at its
   * **actual** value — a variable can't smuggle a large page past the budget. With Yoga
   * `batching` enabled the budget covers the **whole batch**: the operations' costs are summed
   * when the request is parsed, and a batch over the budget is refused (`400`) before any of
   * them runs.
   */
  maxCost?: number | false;
  /** Tune the {@linkcode GraphqlOptions.maxCost} estimate (field weight, which args multiply). */
  costOptions?: CostOptions;
  /**
   * Require the same-origin proof denext applies to every state-changing RPC (Server Actions,
   * the typed-API batch) on non-GET requests: a cross-site `<form>` or fetch is refused with
   * 403 before Yoga parses it. Default `true`. Turn off only for a public, cookie-free API —
   * resolvers run in the viewer's session, so a mutation reached cross-site is a CSRF.
   */
  requireSameOrigin?: boolean;
  /** Extra origins (`https://app.example.com`) allowed to call mutations, beyond the request's own host. */
  allowedOrigins?: string[];
  /** Build the per-request context your resolvers receive (merged with Yoga's). */
  context?: (init: GraphqlContextInit) => object | Promise<object>;
  /**
   * Further Yoga options: `plugins`, `maskedErrors`, `cors`, `batching`, `logging`, …
   * Note `cors` defaults to OFF here (Yoga's own default reflects any `Origin` with
   * credentials); set `cors: { origin: [...] }` to open the endpoint to named sites.
   */
  yoga?: YogaPassthrough;
  /** The SDL file `denext build` writes into the output directory (default `schema.graphql`); `false` skips it. */
  outFile?: string | false;
  /**
   * Serve GraphQL over WebSocket — the `graphql-ws` protocol (subprotocol
   * `graphql-transport-ws`) — on the same path, next to GraphQL over SSE. On by default; `false`
   * turns it off. The handshake needs a browser `Origin` on the app's own host (or in
   * `allowedOrigins`, or the app's `desktop.app.origin`) unless `requireSameOrigin: false`; the
   * socket's identity is the upgrade request's cookies / `Authorization`, or a `connection_init`
   * payload token (`{ authorization: "Bearer …" }` or `{ token }`) when the upgrade carried no
   * `Authorization`. Every operation passes the same depth / cost limits as over HTTP.
   */
  websocket?: WebSocketOptions | false;
  /**
   * Under `denext dev`, the files whose edit reloads the schema (globs, relative to the project
   * root). Default: the scripts and `.graphql` files in the schema module's directory and below
   * (the schema module alone when it sits at the project root) — the module path given, or the
   * module a schema object / factory was traced to. In-flight subscriptions on the old schema end
   * (`complete`). A schema object that cannot be traced (it is built in `denext.config.ts`
   * itself, or reached through a non-relative import) needs a restart after an edit; a dev notice
   * says so.
   */
  watch?: string[];
}

/**
 * Create the GraphQL plugin. Place it in your `denext.config.ts` `plugins`.
 *
 * @param options The schema, endpoint path, GraphiQL, context factory, Yoga passthrough.
 */
export function graphql(options: GraphqlOptions): DenextPlugin {
  if (!options?.schema) throw new TypeError("graphql(): `schema` is required");
  return {
    name: "@denext/graphql",
    async setup(ctx: PluginContext) {
      const {
        path,
        dev,
        graphiql,
        introspection,
        maxBodyBytes,
        sameOrigin,
        maxDepth,
        maxCost,
      } = settingsOf(options, ctx);
      const originOptions = { allowedOrigins: options.allowedOrigins };
      // One budget for both long-lived transports (WebSocket, streamed responses).
      const caps = resolveCaps(options, ctx.config.live?.limits);
      const connections = createConnectionLimiter(() => caps);
      const upgradeOptions = {
        allowedOrigins: options.allowedOrigins,
        desktopAppOrigin: ctx.config.desktop?.app?.origin,
      };
      // One schema generation: its schema, Yoga and SDL, and the signal that ends the
      // subscriptions it serves. A dev reload starts a new one and aborts the old.
      let ended = new AbortController();
      let getSchema = once(() => resolveSchema(options.schema, ctx));
      // A dev reload re-imports the schema from its module: the path given, or the module a
      // schema object / factory imported into the config was traced to.
      const reloadFrom = dev ? await reloadSourceOf(options.schema, ctx) : null;
      const yogaFor = (end: AbortSignal) =>
        once(async () =>
          createYoga({
            cors: false, // never reflect an arbitrary Origin with credentials; opt in via `yoga.cors`
            ...options.yoga,
            plugins: [
              endSubscriptionsOn(end),
              ...(maxDepth === false ? [] : [limitDepth(maxDepth)]),
              ...(maxCost === false ? [] : [
                limitCost(maxCost, options.costOptions),
                limitBatchCost(maxCost, options.costOptions),
              ]),
              ...(introspection ? [] : [disableIntrospection(), blockFieldSuggestions()]),
              ...(options.yoga?.plugins ?? []),
            ],
            schema: await getSchema(),
            graphqlEndpoint: path,
            graphiql,
            context: (init: YogaInitialContext) =>
              options.context?.({ request: init.request, signal: init.request.signal }) ?? {},
          })
        );
      let getYoga = yogaFor(ended.signal);
      let stale = false;
      const reload = () => {
        stale = false;
        ended.abort();
        ended = new AbortController();
        getSchema = once(() => resolveSchema(reloadFrom!.source, ctx));
        getYoga = yogaFor(ended.signal);
        getSdl = sdlOnce();
      };
      if (reloadFrom) {
        ctx.addPrepareStep(() => {
          stale = true; // reloaded by the next request, after the dev server applied the edit
        }, { watch: options.watch ?? defaultSchemaWatch(reloadFrom.watch) });
      }

      const wsDeps = socketDeps(options.websocket, {
        getYoga: () => getYoga(),
        maxBodyBytes,
        acquire: () => connections.acquire(),
      });
      /** A WebSocket upgrade: Live's production handshake rule, then the `graphql-ws` socket. */
      const upgrade = (request: Request, deps: GraphqlWsDeps): Response => {
        // A browser `Origin` is required and must be the app's own (or an allowed one) — a
        // WebSocket handshake is not covered by CORS.
        const originOk = request.headers.has("origin") && verifyOrigin(request, upgradeOptions);
        if (sameOrigin && !originOk) return new Response("forbidden", { status: 403 });
        return acceptGraphqlWs(request, deps);
      };
      /** An HTTP request through Yoga; a streamed response holds a connection slot until it ends. */
      const serveHttp = async (request: Request): Promise<Response> => {
        const mutating = request.method !== "GET" && request.method !== "HEAD";
        if (mutating && sameOrigin && !verifyOrigin(request, originOptions)) {
          return new Response("forbidden", { status: 403 });
        }
        const bounded = mutating ? await capBody(request, maxBodyBytes) : request;
        if (bounded instanceof Response) return bounded;
        // SSE / multipart (a subscription) is refused before Yoga runs when the caps are reached.
        const release = wantsStream(bounded) ? connections.acquire() : null;
        if (release instanceof Response) return release;
        let raw: unknown;
        try {
          raw = await (await getYoga()).fetch(bounded);
        } catch (err) {
          release?.();
          throw err;
        }
        if (release) return releaseWhenDone(raw as Response, release);
        return nativeResponse(raw);
      };

      ctx.addRequestHandler((request) => {
        if (new URL(request.url).pathname !== path) return null;
        if (stale) reload();
        if (wsDeps && isWebSocketUpgrade(request)) return upgrade(request, wsDeps);
        return serveHttp(request);
      });

      // The SDL (build step + CLI) comes from an introspection round-trip through a private
      // Yoga instance — never from printing the app's schema OBJECTS with this package's
      // `graphql`, which may be a different realm than the one Pothos/Yoga bound to.
      const sdlOnce = () =>
        once(async () => {
          const probe = createYoga({
            schema: await getSchema(),
            graphqlEndpoint: path,
            graphiql: false,
            cors: false,
            maskedErrors: false,
            logging: false,
          });
          const res = await probe.fetch(
            new Request(`http://denext.internal${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ query: getIntrospectionQuery() }),
            }),
          );
          const body = await res.json() as { data?: IntrospectionQuery; errors?: unknown };
          if (!body.data) {
            throw new Error(`denext graphql: introspection failed: ${JSON.stringify(body.errors)}`);
          }
          return sdlFromIntrospection(body.data);
        });
      let getSdl = sdlOnce();

      const outFile = options.outFile ?? "schema.graphql";
      // The SDL is a server artifact (a static export serves no GraphQL endpoint), so an export
      // writes none — and runs no introspection that could fail it.
      if (outFile !== false && ctx.mode !== "export") {
        ctx.addBuildStep(async ({ outDir }) => {
          const dest = join(outDir, outFile);
          await Deno.mkdir(join(dest, ".."), { recursive: true });
          await Deno.writeTextFile(dest, await getSdl());
        });
      }

      ctx.addCommand(createGraphqlCommand(() => getSdl()));
    },
  };
}

/** The options with their defaults (dev turns GraphiQL and introspection on). */
function settingsOf(options: GraphqlOptions, ctx: PluginContext) {
  const dev = ctx.mode === "dev";
  return {
    // The pipeline strips `basePath` before the plugin seam, so the path is app-relative.
    path: options.path ?? "/graphql",
    dev,
    graphiql: options.graphiql ?? dev,
    introspection: options.introspection ?? dev,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    sameOrigin: options.requireSameOrigin ?? true,
    maxDepth: options.maxDepth ?? 12,
    maxCost: options.maxCost ?? false,
  };
}

/** The WebSocket transport's dependencies, or `null` when `websocket: false`. */
function socketDeps(
  websocket: WebSocketOptions | false | undefined,
  from: {
    getYoga: () => Promise<unknown>;
    maxBodyBytes: number;
    acquire: GraphqlWsDeps["acquire"];
  },
): GraphqlWsDeps | null {
  if (websocket === false) return null;
  return {
    getEnveloped: async (init) =>
      ((await from.getYoga()) as {
        getEnveloped(init: Record<string, unknown>): EnvelopedLike;
      }).getEnveloped(init),
    connectionInitTimeoutMs: websocket?.connectionInitTimeoutMs ?? 3000,
    maxOperations: websocket?.maxSubscriptions ?? 32,
    maxMessageBytes: from.maxBodyBytes,
    acquire: from.acquire,
  };
}

/** Yoga's Response may come from its own fetch ponyfill; hand the pipeline a native one. */
function nativeResponse(raw: unknown): Response {
  if (raw instanceof Response) return raw;
  const res = raw as Response;
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

async function resolveSchema(
  source: SchemaSource | TracedExport,
  ctx: PluginContext,
): Promise<GraphQLSchema> {
  if (typeof source === "function") return await source();
  if (isTraced(source)) return await fromModule(ctx, source.file, source.name);
  if (typeof source !== "string") return source;
  return await fromModule(ctx, isAbsolute(source) ? source : join(ctx.projectRoot, source));
}

/** The schema a module exports: `name`, else its `schema` export, else its default one. */
async function fromModule(
  ctx: PluginContext,
  file: string,
  name?: string,
): Promise<GraphQLSchema> {
  const mod = await ctx.load(file) as Record<string, unknown>;
  const exported = name ? mod[name] : mod.schema ?? mod.default;
  if (exported == null) {
    throw new Error(`graphql(): ${file} exports no \`${name ?? "schema"}\` (nor a default export)`);
  }
  return typeof exported === "function"
    ? await (exported as () => GraphQLSchema | Promise<GraphQLSchema>)()
    : exported as GraphQLSchema;
}

function isTraced(source: unknown): source is TracedExport {
  return typeof source === "object" && source !== null && "file" in source && "name" in source &&
    !("getQueryType" in source);
}

/** Where a dev reload re-imports the schema from, and the path its default watch globs follow. */
interface ReloadSource {
  source: string | TracedExport;
  watch: string;
}

/**
 * The module a dev reload re-imports the schema from: a module path as given; a schema object or
 * factory traced to the project module exporting it; else `null` (a dev notice: edits need a
 * restart).
 */
async function reloadSourceOf(
  schema: SchemaSource,
  ctx: PluginContext,
): Promise<ReloadSource | null> {
  if (typeof schema === "string") return { source: schema, watch: schema };
  const traced = await traceExport(schema, ctx.projectRoot);
  if (traced) return { source: traced, watch: relative(ctx.projectRoot, traced.file) };
  console.warn(
    "[@denext/graphql] could not trace the module that exports `schema` (a relative import of " +
      "denext.config.*); a schema edit needs a dev-server restart. Pass its module path " +
      '(`schema: "./app/graphql/schema.ts"`) to reload it on an edit.',
  );
  return null;
}

/** The dev watch globs for a schema module path (see {@linkcode GraphqlOptions.watch}). */
function defaultSchemaWatch(source: string): string[] {
  const dir = dirname(normalize(source));
  if (dir === "." || dir === "/") return [source];
  return [join(dir, "**", "*.{ts,tsx,js,jsx,mts,mjs,graphql,gql}")];
}

/**
 * A Yoga (envelop) plugin that ends every subscription stream when `end` aborts — a dev schema
 * reload, so a client on the old schema gets `complete` and resubscribes against the new one.
 */
function endSubscriptionsOn(end: AbortSignal): NonNullable<YogaPassthrough["plugins"]>[number] {
  return {
    onSubscribe() {
      return {
        onSubscribeResult(
          { result, setResult }: { result: unknown; setResult: (r: unknown) => void },
        ) {
          if (isAsyncIterable(result)) setResult(endOnAbort(result, end));
        },
      };
    },
  } as NonNullable<YogaPassthrough["plugins"]>[number];
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === "object" && v !== null && Symbol.asyncIterator in v;
}

/** `source`, ended (and returned) as soon as `signal` aborts — even while a `next()` waits. */
function endOnAbort<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncIterableIterator<T> {
  const it = source[Symbol.asyncIterator]();
  const done = { value: undefined as never, done: true } as IteratorResult<T>;
  let onAbort = () => {};
  const ended = new Promise<IteratorResult<T>>((resolve) => {
    onAbort = () => {
      void Promise.resolve(it.return?.()).catch(() => {});
      resolve(done);
    };
  });
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const release = () => signal.removeEventListener("abort", onAbort);
  const wrapped: AsyncIterableIterator<T> = {
    next: () => (signal.aborted ? ended : Promise.race([it.next(), ended])),
    return: (value?: unknown) => {
      release();
      return it.return ? it.return(value) : Promise.resolve(done);
    },
    throw: (err?: unknown) => {
      release();
      return it.throw ? it.throw(err) : Promise.reject(err);
    },
    [Symbol.asyncIterator]: () => wrapped,
  };
  return wrapped;
}

/** Memoize a successful result; a rejection is NOT kept, so a transient failure retries. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    p ??= fn().catch((err) => {
      p = null;
      throw err;
    });
    return p;
  };
}

/** Read the body under the cap (the route-handler cap does not reach a plugin handler). */
async function capBody(request: Request, maxBytes: number): Promise<Request | Response> {
  if (!request.body) return request;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return new Response("payload too large", { status: 413 });
  const body = await readCappedBody(request, maxBytes);
  if (body === TOO_LARGE) return new Response("payload too large", { status: 413 });
  if (body === STALLED) return new Response("request timeout", { status: 408 });
  return bufferedRequest(request, body);
}

/**
 * A Yoga (envelop) plugin that refuses introspection queries. Written against the AST shape
 * and Yoga's own `createGraphQLError` — never a value import from `graphql`, so the plugin
 * cannot introduce a second `graphql` realm next to the app's (Pothos / Yoga share one).
 */
function disableIntrospection(): NonNullable<YogaPassthrough["plugins"]>[number] {
  const rule = (context: ValidationContext) => ({
    Field(node: FieldNode) {
      const name = node.name.value;
      if (name === "__schema" || name === "__type") {
        context.reportError(
          createGraphQLError("GraphQL introspection is disabled on this server", { nodes: [node] }),
        );
      }
    },
  });
  return {
    onValidate({ addValidationRule }: { addValidationRule: (rule: unknown) => void }) {
      addValidationRule(rule);
    },
  } as NonNullable<YogaPassthrough["plugins"]>[number];
}

/** Index a document's fragment definitions by name, for the traversals below. */
function collectFragments(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === "FragmentDefinition") fragments.set(def.name.value, def);
  }
  return fragments;
}

/** A positive integer from an AST `IntValue` string, or `undefined`. */
function positiveInt(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The multiplier a field applies to its subtree cost: `1` when it carries no pagination
 * argument (no fan-out), the concrete integer when the page size is a literal, the request's
 * actual variable value when it's `first: $n` (so a variable can't smuggle a huge page past
 * the budget), the variable's AST default when the request omits it, and `defaultMultiplier`
 * only when a pagination arg is present but its value is genuinely unknowable.
 */
/** Multiplier for a `first: $var` page size: the request's value, else the AST default, else `defaultMultiplier`. */
function variableMultiplier(
  name: string,
  varDefs: Map<string, VariableDefinitionNode>,
  vars: Record<string, unknown>,
  defaultMultiplier: number,
): number {
  const runtime = vars[name];
  if (typeof runtime === "number" && Number.isFinite(runtime) && runtime > 0) {
    return Math.floor(runtime);
  }
  const dflt = varDefs.get(name)?.defaultValue;
  if (dflt?.kind === "IntValue") return positiveInt(dflt.value) ?? defaultMultiplier;
  return defaultMultiplier;
}

function argMultiplier(
  field: FieldNode,
  argNames: ReadonlySet<string>,
  varDefs: Map<string, VariableDefinitionNode>,
  vars: Record<string, unknown>,
  defaultMultiplier: number,
): number {
  for (const arg of field.arguments ?? []) {
    if (!argNames.has(arg.name.value)) continue;
    const v = arg.value;
    if (v.kind === "IntValue") return positiveInt(v.value) ?? defaultMultiplier;
    if (v.kind === "Variable") {
      return variableMultiplier(v.name.value, varDefs, vars, defaultMultiplier);
    }
    return defaultMultiplier; // pagination arg present but some other value kind
  }
  return 1; // no pagination argument → this field does not fan out
}

/**
 * Estimated cost of the operation `document`/`operationName` would run, given the request's
 * `variableValues`. Each field costs `fieldCost`; a field with a pagination argument multiplies
 * its subtree by the (variable-resolved) page size. Fragment costs are **memoized by name**
 * (a fragment's cost is self-contained), so a document that spreads a fragment along many
 * non-cyclic paths — a "fragment bomb" — is estimated in linear time rather than exponential.
 * Cyclic fragments (rejected earlier by graphql's own rule) can't recurse forever: a name on
 * the current path contributes `0`.
 */
function estimateOperationCost(
  document: DocumentNode,
  operationName: string | null | undefined,
  variableValues: Record<string, unknown> | null | undefined,
  fieldCost: number,
  argNames: ReadonlySet<string>,
  defaultMultiplier: number,
): number {
  const operation = operationOf(document, operationName);
  if (!operation) return 0; // ambiguous / none — let graphql surface the error
  const varDefs = new Map<string, VariableDefinitionNode>();
  for (const vd of operation.variableDefinitions ?? []) varDefs.set(vd.variable.name.value, vd);
  return selectionCost(operation.selectionSet, {
    fieldCost,
    argNames,
    varDefs,
    vars: variableValues ?? {},
    defaultMultiplier,
    fragments: collectFragments(document),
    cache: new Map(),
    onPath: new Set(),
  });
}

/**
 * Memoize a per-fragment numeric fold: return the cached value, `0` for a name already on the
 * walk path (a cycle — rejected elsewhere by graphql's `NoFragmentCyclesRule`), else compute
 * it with `compute`, cache it, and return it. Shared by the cost and depth walks so a fragment
 * reached along many non-cyclic paths is folded once (linear, not exponential).
 */
function memoFragment(
  name: string,
  fragments: Map<string, FragmentDefinitionNode>,
  cache: Map<string, number>,
  onPath: Set<string>,
  compute: (selectionSet: SelectionSetNode) => number,
): number {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  if (onPath.has(name)) return 0;
  const frag = fragments.get(name);
  if (!frag) return 0;
  onPath.add(name);
  const value = compute(frag.selectionSet);
  onPath.delete(name);
  cache.set(name, value);
  return value;
}

/** State threaded through {@linkcode selectionCost}. */
interface CostContext {
  fieldCost: number;
  argNames: ReadonlySet<string>;
  varDefs: Map<string, VariableDefinitionNode>;
  vars: Record<string, unknown>;
  defaultMultiplier: number;
  fragments: Map<string, FragmentDefinitionNode>;
  cache: Map<string, number>;
  onPath: Set<string>;
}

/** Cost of a selection set: each field `fieldCost`, a paginated field's subtree × its page size. */
function selectionCost(selectionSet: SelectionSetNode, ctx: CostContext): number {
  let total = 0;
  for (const sel of selectionSet.selections) {
    if (sel.kind === "Field") {
      total += ctx.fieldCost;
      if (sel.selectionSet) {
        const m = argMultiplier(sel, ctx.argNames, ctx.varDefs, ctx.vars, ctx.defaultMultiplier);
        total += m * selectionCost(sel.selectionSet, ctx);
      }
    } else if (sel.kind === "InlineFragment") {
      if (sel.selectionSet) total += selectionCost(sel.selectionSet, ctx);
    } else {
      total += memoFragment(
        sel.name.value,
        ctx.fragments,
        ctx.cache,
        ctx.onPath,
        (ss) => selectionCost(ss, ctx),
      );
    }
  }
  return total;
}

/** The max field-selection nesting a selection set reaches, following fragments (memoized). */
function selectionDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  cache: Map<string, number>,
  onPath: Set<string>,
): number {
  let deepest = 0;
  for (const sel of selectionSet.selections) {
    let d = 0;
    if (sel.kind === "Field") {
      d = sel.selectionSet ? 1 + selectionDepth(sel.selectionSet, fragments, cache, onPath) : 0;
    } else if (sel.kind === "InlineFragment") {
      d = sel.selectionSet ? selectionDepth(sel.selectionSet, fragments, cache, onPath) : 0;
    } else {
      d = memoFragment(
        sel.name.value,
        fragments,
        cache,
        onPath,
        (ss) => selectionDepth(ss, fragments, cache, onPath),
      );
    }
    if (d > deepest) deepest = d;
  }
  return deepest;
}

/**
 * A Yoga (envelop) plugin that rejects a query whose selection nesting exceeds `max`. Depth is
 * measured over the AST (fields, inline fragments, and named fragments followed through the
 * document), with **per-fragment memoization** so a fragment reachable by many non-cyclic
 * paths is measured once — a linear-size document can't force an exponential walk. No value
 * import from `graphql`, so it introduces no second realm.
 */
function limitDepth(max: number): NonNullable<YogaPassthrough["plugins"]>[number] {
  const rule = (context: ValidationContext) => {
    const fragments = collectFragments(context.getDocument());
    const cache = new Map<string, number>();
    const onPath = new Set<string>();
    return {
      OperationDefinition(node: OperationDefinitionNode) {
        if (selectionDepth(node.selectionSet, fragments, cache, onPath) > max) {
          context.reportError(
            createGraphQLError(`Query is nested too deeply (max depth ${max})`, {
              nodes: [node.selectionSet],
            }),
          );
        }
      },
    };
  };
  return {
    onValidate({ addValidationRule }: { addValidationRule: (rule: unknown) => void }) {
      addValidationRule(rule);
    },
  } as NonNullable<YogaPassthrough["plugins"]>[number];
}

/** Args an execute/subscribe hook exposes that {@linkcode limitCost} reads. */
interface CostCheckArgs {
  document: DocumentNode;
  operationName?: string | null;
  variableValues?: Record<string, unknown> | null;
}

/**
 * A Yoga (envelop) plugin that refuses a query whose estimated cost exceeds `max`. It runs at
 * the **execute/subscribe** phase (not validation) so it sees the request's real
 * `variableValues` — a page size passed as `first: $n` is counted at its actual value, closing
 * the bypass a literal-only AST check would leave open. Cost is summed over the AST (no schema,
 * no resolver run, no second `graphql` realm) with memoized fragment costs, so it is linear in
 * document size. See {@linkcode estimateOperationCost}.
 */
function limitCost(
  max: number,
  opts: CostOptions = {},
): NonNullable<YogaPassthrough["plugins"]>[number] {
  const estimate = costEstimator(opts);
  const check = (
    args: CostCheckArgs,
    stop: (result: { errors: unknown[] }) => void,
  ): void => {
    const total = estimate(args.document, args.operationName, args.variableValues);
    if (total > max) {
      stop({ errors: [createGraphQLError(`Query is too expensive (cost ${total}, max ${max})`)] });
    }
  };
  return {
    onExecute(
      { args, setResultAndStopExecution }: {
        args: CostCheckArgs;
        setResultAndStopExecution: (result: { errors: unknown[] }) => void;
      },
    ) {
      check(args, setResultAndStopExecution);
    },
    onSubscribe(
      { args, setResultAndStopExecution }: {
        args: CostCheckArgs;
        setResultAndStopExecution: (result: { errors: unknown[] }) => void;
      },
    ) {
      check(args, setResultAndStopExecution);
    },
  } as NonNullable<YogaPassthrough["plugins"]>[number];
}

/** The cost estimate under `opts` (see {@linkcode estimateOperationCost}). */
function costEstimator(
  opts: CostOptions,
): (doc: DocumentNode, name?: string | null, vars?: Record<string, unknown> | null) => number {
  const fieldCost = opts.fieldCost ?? 1;
  const argNames = new Set(opts.listMultiplierArgs ?? ["first", "last", "limit"]);
  const defaultMultiplier = opts.defaultMultiplier ?? 1;
  return (doc, name, vars) =>
    estimateOperationCost(doc, name, vars, fieldCost, argNames, defaultMultiplier);
}

/** One operation's GraphQL-over-HTTP parameters, as Yoga's request parser yields them. */
interface BatchParams {
  query?: string;
  operationName?: string | null;
  variables?: Record<string, unknown> | null;
}

/**
 * The summed estimate of a batch's operations. An operation whose `query` does not parse (or is
 * absent — a persisted-document id) adds nothing here: Yoga reports the parse error, and the
 * per-operation check still runs at execute time.
 */
function batchCost(batch: readonly BatchParams[], opts: CostOptions): number {
  const estimate = costEstimator(opts);
  let total = 0;
  for (const params of batch) {
    if (typeof params?.query !== "string") continue;
    let document: DocumentNode;
    try {
      document = parse(params.query);
    } catch {
      continue;
    }
    total += estimate(document, params.operationName, params.variables);
  }
  return total;
}

/**
 * A Yoga (envelop) plugin that charges a **batch** (Yoga `batching`: a JSON array of operations)
 * against one budget: when the request is parsed — before any operation runs — the operations'
 * estimated costs are summed, and a batch over `max` is refused with a `400` and no operation
 * executed. {@linkcode limitCost} still checks each operation (with its variables) as it runs.
 */
function limitBatchCost(
  max: number,
  opts: CostOptions = {},
): NonNullable<YogaPassthrough["plugins"]>[number] {
  return {
    onRequestParse() {
      return {
        onRequestParseDone({ requestParserResult }: { requestParserResult: unknown }) {
          if (!Array.isArray(requestParserResult) || requestParserResult.length < 2) return;
          const total = batchCost(requestParserResult as BatchParams[], opts);
          if (total > max) {
            throw createGraphQLError(`Batch is too expensive (cost ${total}, max ${max})`, {
              extensions: { http: { status: 400 }, code: "BATCH_TOO_EXPENSIVE" },
            });
          }
        },
      };
    },
  } as NonNullable<YogaPassthrough["plugins"]>[number];
}

/**
 * Strip graphql's "Did you mean …?" field suggestions from validation errors — with
 * introspection off, they otherwise let a caller reconstruct the schema field by field.
 */
function blockFieldSuggestions(): NonNullable<YogaPassthrough["plugins"]>[number] {
  const strip = (message: string): string =>
    message.replace(/ ?Did you mean[^?]*\?/g, "").replace(/ ?Did you mean .*$/g, "");
  return {
    // envelop's `onValidate` returns an AFTER hook (a function), not an object.
    onValidate() {
      return ({ valid, result, setResult }: {
        valid: boolean;
        result: readonly { message: string }[];
        setResult: (errors: unknown[]) => void;
      }) => {
        if (valid) return;
        setResult(
          result.map((e) =>
            e.message.includes("Did you mean") ? createGraphQLError(strip(e.message)) : e
          ),
        );
      };
    },
  } as NonNullable<YogaPassthrough["plugins"]>[number];
}
