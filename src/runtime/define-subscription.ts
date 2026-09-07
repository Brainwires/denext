// Typed, validated live queries — `defineSubscription`, the `useLive` twin of `defineApi`.
//
//   // app/subscriptions.ts
//   "use server";
//   import { defineSubscription } from "denext/server";
//   export const orderStatus = defineSubscription({
//     input: z.object({ id: z.string() }),
//     tags: ({ id }) => [`order:${id}`],                 // server-derived; the client's tags are ignored
//     authorize: async ({ id }) => (await auth())?.user.id === (await db.orders.owner(id)),
//     resolve: ({ id }) => db.orders.status(id),          // Out inferred
//   });
//
//   // a client component
//   const { data, error, status } = useSubscription(orderStatus, { id }, { initial });
//
// A `useLive` data subscription took untyped `args`, trusted the client's `tags`, and gated
// only on `liveReadable` / `canSubscribe`. A subscription DEFINITION adds what the socket was
// missing: the client's input is validated by a Standard Schema on every `data-subscribe`
// (rejected → `invalid-input` with field errors, nothing stored), the tags are derived on the
// server from the parsed input, and an optional row-level `authorize` runs on EVERY recompute
// (denied → the subscription is dropped). Registering the definition IS the live opt-in.
//
// The exported ref is also a plain callable (`await orderStatus({ id })` — validate →
// authorize → resolve under the current request), so SSR can compute `initial` and the HTTP
// action dispatch keeps working. Exported from a `"use server"` module it crosses to the
// browser as an opaque id (the generated stub), exactly like a Server Action.

import {
  ActionValidationError,
  fieldErrorsFrom,
  isStandardSchema,
  type StandardSchemaV1,
} from "./define-action.ts";
import {
  clientActionStub,
  registerServerReference,
  registerSubscription,
  SUBSCRIPTION_DEF,
  type SubscriptionDef,
} from "./server-action.ts";

/** What a subscription's `authorize` / `resolve` receive besides the input. */
export interface SubscriptionContext {
  /**
   * The Live connection's identity when run over the socket (origin, url, cookie, peerId);
   * `null` on the one-shot path (SSR `initial`, an HTTP dispatch).
   */
  connection: { origin: string; url: string; cookie: string; peerId: string } | null;
  /** The recompute deadline (Live) or the request's signal. */
  signal?: AbortSignal;
}

/** The definition passed to {@link defineSubscription}. */
export interface SubscriptionConfig<In, Out> {
  /** An explicit stable id; otherwise the export must live in a `"use server"` module. */
  id?: string;
  /**
   * Validates the client-supplied input. Strongly recommended whenever `In` is not `void`:
   * without a schema the raw client value reaches `tags`, `authorize` and `resolve`
   * unvalidated (not enforced at runtime — the type system cannot see it).
   */
  input?: StandardSchemaV1<In>;
  /** Static tags, or tags derived from the parsed input (`({ id }) => ["order:" + id]`). */
  tags?: readonly string[] | ((input: In) => readonly string[]);
  /** Row-level gate, re-run on every recompute; `false` denies and drops the subscription. */
  authorize?: (input: In, ctx: SubscriptionContext) => boolean | Promise<boolean>;
  /** Computes the value pushed to the client. */
  resolve: (input: In, ctx: SubscriptionContext) => Out | Promise<Out>;
}

/**
 * The reference `defineSubscription` returns: callable on the server (validate → authorize →
 * resolve), an opaque id on the client; typed for `useSubscription`.
 */
export interface SubscriptionRef<In, Out> {
  /** One-shot: validate, authorize, resolve under the current request. */
  (input: In): Promise<Out>;
  /** The stable server-reference id (assigned at export by the `"use server"` tagging). */
  readonly denextActionId: string;
  /** Phantom — never present at runtime; carries the types for the client hook. */
  readonly __sub?: { input: In; output: Out };
}

/**
 * Define a typed, validated live query. Export it from a `"use server"` module (or give it an
 * `id`) and subscribe from the client with `useSubscription`.
 *
 * @param config Input schema, tag derivation, row-level authorize, and the resolver.
 * @returns The subscription reference.
 */
export function defineSubscription<Out, In = void>(
  config: SubscriptionConfig<In, Out>,
): SubscriptionRef<In, Out> {
  if (typeof document !== "undefined") {
    // A browser bundle: a "use server" export was replaced by the generated stub before this
    // ran; only the explicit-id form reaches here.
    return clientActionStub<[In], Out>(config.id ?? "") as unknown as SubscriptionRef<In, Out>;
  }
  const def = buildDef(config);
  const oneShot = async (input: In): Promise<Out> => {
    const { parsed } = await def.parse(input);
    if (def.authorize && !(await def.authorize(parsed, { connection: null }))) {
      throw new ActionValidationError("not permitted");
    }
    return (await def.run(parsed, { connection: null })) as Out;
  };
  Object.defineProperty(oneShot, SUBSCRIPTION_DEF, { value: def });
  if (config.id) {
    registerServerReference(config.id, oneShot);
    registerSubscription(config.id, def);
    // `registerServerReference` tags a wrapper it returns; the ref handed out here is
    // `oneShot` itself, so tag it too — `useSubscription` subscribes by this id.
    Object.defineProperty(oneShot, "denextActionId", { value: config.id, configurable: true });
  }
  return oneShot as unknown as SubscriptionRef<In, Out>;
}

/** Turn the config into the hub-facing definition (parse / authorize / run). */
function buildDef<In, Out>(config: SubscriptionConfig<In, Out>): SubscriptionDef {
  const tagsOf = (input: In): string[] =>
    typeof config.tags === "function" ? [...config.tags(input)] : [...(config.tags ?? [])];
  return {
    async parse(raw: unknown) {
      const parsed = (await parseInput(config.input, raw)) as In;
      return { parsed, tags: tagsOf(parsed) };
    },
    authorize: config.authorize
      ? (parsed, ctx) => Promise.resolve(config.authorize!(parsed as In, ctx))
      : undefined,
    run: (parsed, ctx) => Promise.resolve(config.resolve(parsed as In, ctx)),
  };
}

/** Validate the raw client input (throws {@link ActionValidationError} with field errors). */
async function parseInput<In>(schema: StandardSchemaV1<In> | undefined, raw: unknown): Promise<In> {
  if (!schema) return raw as In;
  if (!isStandardSchema(schema)) {
    throw new TypeError("defineSubscription: `input` is not a Standard Schema");
  }
  const result = await schema["~standard"].validate(raw);
  if (result.issues) {
    throw new ActionValidationError("Validation failed", fieldErrorsFrom(result.issues));
  }
  return result.value;
}
