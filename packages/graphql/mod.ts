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
import { join } from "@std/path";
import type {
  FieldNode,
  FragmentDefinitionNode,
  GraphQLSchema,
  IntrospectionQuery,
  OperationDefinitionNode,
  SelectionSetNode,
  ValidationContext,
} from "graphql";
import { getIntrospectionQuery } from "graphql";
import {
  createGraphQLError,
  createYoga,
  type YogaInitialContext,
  type YogaServerOptions,
} from "graphql-yoga";
import { createGraphqlCommand, sdlFromIntrospection } from "./command.ts";

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
   * guard); set a number (a budget of ~1000 suits most apps) to enable it. A pagination size
   * passed as a **variable** (`first: $n`) uses {@linkcode CostOptions.defaultMultiplier}, since
   * variable values aren't known at validation time.
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
      // The pipeline strips `basePath` before the plugin seam, so the path is app-relative.
      const path = options.path ?? "/graphql";
      const dev = ctx.mode === "dev";
      const graphiql = options.graphiql ?? dev;
      const introspection = options.introspection ?? dev;
      const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
      const sameOrigin = options.requireSameOrigin ?? true;
      const originOptions = { allowedOrigins: options.allowedOrigins };
      const maxDepth = options.maxDepth ?? 12;
      const maxCost = options.maxCost ?? false;
      const getSchema = once(() => Promise.resolve(resolveSchema(options.schema)));
      const getYoga = once(async () =>
        createYoga({
          cors: false, // never reflect an arbitrary Origin with credentials; opt in via `yoga.cors`
          ...options.yoga,
          plugins: [
            ...(maxDepth === false ? [] : [limitDepth(maxDepth)]),
            ...(maxCost === false ? [] : [limitCost(maxCost, options.costOptions)]),
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

      ctx.addRequestHandler(async (request) => {
        if (new URL(request.url).pathname !== path) return null;
        const mutating = request.method !== "GET" && request.method !== "HEAD";
        if (mutating && sameOrigin && !verifyOrigin(request, originOptions)) {
          return new Response("forbidden", { status: 403 });
        }
        const bounded = mutating ? await capBody(request, maxBodyBytes) : request;
        if (bounded instanceof Response) return bounded;
        const yoga = await getYoga();
        const raw: unknown = await yoga.fetch(bounded);
        // Yoga's Response may come from its own fetch ponyfill; hand the pipeline a native one.
        if (raw instanceof Response) return raw;
        const res = raw as Response;
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      });

      // The SDL (build step + CLI) comes from an introspection round-trip through a private
      // Yoga instance — never from printing the app's schema OBJECTS with this package's
      // `graphql`, which may be a different realm than the one Pothos/Yoga bound to.
      const getSdl = once(async () => {
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

      const outFile = options.outFile ?? "schema.graphql";
      if (outFile !== false) {
        ctx.addBuildStep(async ({ outDir }) => {
          const dest = join(outDir, outFile);
          await Deno.mkdir(join(dest, ".."), { recursive: true });
          await Deno.writeTextFile(dest, await getSdl());
        });
      }

      ctx.addCommand(createGraphqlCommand(getSdl));
    },
  };
}

function resolveSchema(source: SchemaSource): GraphQLSchema | Promise<GraphQLSchema> {
  return typeof source === "function" ? source() : source;
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

/** Index a document's fragment definitions by name, for the validation walks below. */
function collectFragments(context: ValidationContext): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of context.getDocument().definitions) {
    if (def.kind === "FragmentDefinition") fragments.set(def.name.value, def);
  }
  return fragments;
}

/**
 * A Yoga (envelop) plugin that rejects a query whose selection nesting exceeds `max`. Counts
 * depth over the AST (fields, inline fragments, and named fragments followed through the
 * document) — no value import from `graphql`, so it introduces no second realm.
 */
function limitDepth(max: number): NonNullable<YogaPassthrough["plugins"]>[number] {
  const rule = (context: ValidationContext) => {
    const fragments = collectFragments(context);
    let reported = false;
    // Fragment names currently on the walk path — so a cyclic fragment (`A → B → A`) is not
    // followed into infinite recursion (a stack-overflow DoS). graphql's own
    // NoFragmentCyclesRule reports the cycle, but this manual walk runs in the same pass and
    // would overflow first; a diamond (two spreads of one fragment) still resolves, since the
    // name is only blocked while it is an ancestor.
    const onPath = new Set<string>();
    const walk = (selectionSet: SelectionSetNode | undefined, depth: number): void => {
      if (!selectionSet || reported) return;
      if (depth > max) {
        reported = true;
        context.reportError(
          createGraphQLError(`Query is nested too deeply (max depth ${max})`, {
            nodes: [selectionSet],
          }),
        );
        return;
      }
      for (const sel of selectionSet.selections) {
        if (sel.kind === "Field") walk(sel.selectionSet, depth + 1);
        else if (sel.kind === "InlineFragment") walk(sel.selectionSet, depth);
        else if (!onPath.has(sel.name.value)) {
          onPath.add(sel.name.value);
          walk(fragments.get(sel.name.value)?.selectionSet, depth);
          onPath.delete(sel.name.value);
        }
      }
    };
    return {
      OperationDefinition(node: OperationDefinitionNode) {
        walk(node.selectionSet, 0);
      },
    };
  };
  return {
    onValidate({ addValidationRule }: { addValidationRule: (rule: unknown) => void }) {
      addValidationRule(rule);
    },
  } as NonNullable<YogaPassthrough["plugins"]>[number];
}

/**
 * The integer value of the first pagination argument on `field` (from `argNames`), or
 * `undefined` when none is present or the value isn't a positive integer literal (a variable
 * `first: $n`, for instance — its value isn't known at validation time).
 */
function listMultiplier(field: FieldNode, argNames: ReadonlySet<string>): number | undefined {
  for (const arg of field.arguments ?? []) {
    if (!argNames.has(arg.name.value)) continue;
    if (arg.value.kind === "IntValue") {
      const n = Number.parseInt(arg.value.value, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

/**
 * A Yoga (envelop) plugin that rejects a query whose estimated cost exceeds `max`. Cost is
 * summed over the AST (no schema, no resolver run, no second `graphql` realm): each field is
 * worth `fieldCost`, and a field with a pagination argument multiplies its subtree by that
 * integer — so it catches the multiplicative fan-out a depth limit alone misses. Cyclic
 * fragments are guarded like {@linkcode limitDepth} (a name on the current path isn't
 * re-entered), so the walk can't recurse forever.
 */
function limitCost(
  max: number,
  opts: CostOptions = {},
): NonNullable<YogaPassthrough["plugins"]>[number] {
  const fieldCost = opts.fieldCost ?? 1;
  const argNames = new Set(opts.listMultiplierArgs ?? ["first", "last", "limit"]);
  const defaultMultiplier = opts.defaultMultiplier ?? 1;
  const rule = (context: ValidationContext) => {
    const fragments = collectFragments(context);
    const cost = (selectionSet: SelectionSetNode, onPath: Set<string>): number => {
      let total = 0;
      for (const sel of selectionSet.selections) {
        if (sel.kind === "Field") {
          total += fieldCost;
          if (sel.selectionSet) {
            const m = listMultiplier(sel, argNames) ?? defaultMultiplier;
            total += m * cost(sel.selectionSet, onPath);
          }
        } else if (sel.kind === "InlineFragment") {
          if (sel.selectionSet) total += cost(sel.selectionSet, onPath);
        } else if (!onPath.has(sel.name.value)) {
          const frag = fragments.get(sel.name.value);
          if (frag) {
            onPath.add(sel.name.value);
            total += cost(frag.selectionSet, onPath);
            onPath.delete(sel.name.value);
          }
        }
      }
      return total;
    };
    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const total = cost(node.selectionSet, new Set<string>());
        if (total > max) {
          context.reportError(
            createGraphQLError(`Query is too expensive (cost ${total}, max ${max})`, {
              nodes: [node],
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
