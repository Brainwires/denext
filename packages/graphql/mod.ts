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
   * guard); set a number (a budget of ~1000 suits most apps) to enable it. The check runs at
   * execute time, so a page size passed as a **variable** (`first: $n`) is counted at its
   * **actual** value — a variable can't smuggle a large page past the budget. With Yoga
   * `batching` enabled the budget is per-operation, so an N-operation batch may cost up to N×.
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

/** Index a document's fragment definitions by name, for the traversals below. */
function collectFragments(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === "FragmentDefinition") fragments.set(def.name.value, def);
  }
  return fragments;
}

/** The operation `document` would execute for `operationName` (the sole one when unnamed). */
function resolveOperation(
  document: DocumentNode,
  operationName: string | null | undefined,
): OperationDefinitionNode | undefined {
  const ops = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === "OperationDefinition",
  );
  if (operationName) return ops.find((o) => o.name?.value === operationName);
  // No name: valid only when there's exactly one operation; otherwise graphql errors first.
  return ops.length === 1 ? ops[0] : undefined;
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
  const operation = resolveOperation(document, operationName);
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
  const fieldCost = opts.fieldCost ?? 1;
  const argNames = new Set(opts.listMultiplierArgs ?? ["first", "last", "limit"]);
  const defaultMultiplier = opts.defaultMultiplier ?? 1;
  const check = (
    args: CostCheckArgs,
    stop: (result: { errors: unknown[] }) => void,
  ): void => {
    const total = estimateOperationCost(
      args.document,
      args.operationName,
      args.variableValues,
      fieldCost,
      argNames,
      defaultMultiplier,
    );
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
