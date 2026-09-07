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
import { join } from "@std/path";
import type { GraphQLSchema } from "graphql";
import { createYoga, type YogaInitialContext, type YogaServerOptions } from "graphql-yoga";
import { createGraphqlCommand, schemaSdl } from "./command.ts";

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

/** A schema, or a factory for one (resolved once, on first use). */
export type SchemaSource = GraphQLSchema | (() => GraphQLSchema | Promise<GraphQLSchema>);

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

/** Options for {@linkcode graphql}. */
export interface GraphqlOptions {
  /** The schema (Pothos `builder.toSchema()`, `createSchema({ typeDefs, resolvers })`, …). */
  schema: SchemaSource;
  /** Where the endpoint is mounted (default `/graphql`; prefixed with `basePath`). */
  path?: string;
  /** Serve GraphiQL on a browser `GET` (default: dev only). */
  graphiql?: boolean;
  /** Build the per-request context your resolvers receive (merged with Yoga's). */
  context?: (init: GraphqlContextInit) => object | Promise<object>;
  /** Further Yoga options: `plugins`, `maskedErrors`, `cors`, `batching`, `logging`, … */
  yoga?: YogaPassthrough;
  /** The SDL file `denext build` writes into the output directory (default `schema.graphql`); `false` skips it. */
  outFile?: string | false;
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
    setup(ctx: PluginContext) {
      const basePath = (ctx.config.basePath ?? "").replace(/\/$/, "");
      const path = basePath + (options.path ?? "/graphql");
      const graphiql = options.graphiql ?? ctx.mode === "dev";
      const getSchema = once(() => Promise.resolve(resolveSchema(options.schema)));
      const getYoga = once(async () =>
        createYoga({
          ...options.yoga,
          schema: await getSchema(),
          graphqlEndpoint: path,
          graphiql,
          context: (init: YogaInitialContext) =>
            options.context?.({ request: init.request, signal: init.request.signal }) ?? {},
        })
      );

      ctx.addRequestHandler(async (request) => {
        if (new URL(request.url).pathname !== path) return null;
        const yoga = await getYoga();
        const raw: unknown = await yoga.fetch(request);
        // Yoga's Response may come from its own fetch ponyfill; hand the pipeline a native one.
        if (raw instanceof Response) return raw;
        const res = raw as Response;
        return new Response(res.body, { status: res.status, headers: res.headers });
      });

      const outFile = options.outFile ?? "schema.graphql";
      if (outFile !== false) {
        ctx.addBuildStep(async ({ outDir }) => {
          const dest = join(outDir, outFile);
          await Deno.mkdir(join(dest, ".."), { recursive: true });
          await Deno.writeTextFile(dest, schemaSdl(await getSchema()));
        });
      }

      ctx.addCommand(createGraphqlCommand(getSchema));
    },
  };
}

function resolveSchema(source: SchemaSource): GraphQLSchema | Promise<GraphQLSchema> {
  return typeof source === "function" ? source() : source;
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}
