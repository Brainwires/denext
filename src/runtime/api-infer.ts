// Type-level inference for the generated `.denext/api.ts` — zero runtime.
//
// The generator used to spawn `deno doc --json` per route file and re-render each handler's
// `TypedResponse<T>` / `TypedRequest<B>` type arguments as TypeScript text — one subprocess
// per route, sequentially, and a non-exported local type came back as `unknown`. Instead the
// generated module now imports each route's TYPE (`import type * as R0 from "…/route.ts"`) and
// lets TypeScript do the inference through these helpers: `ModuleEndpoints<typeof R0, Params>`
// reads every exported HTTP-method handler and derives its body, query, response, and error
// codes — from a `defineApi` definition (the phantom `__api`) or from `TypedRequest` /
// `TypedResponse` annotations on a plain handler.

import type { HttpMethod } from "../server/types.ts";
import type { TypedRequest, TypedResponse } from "../server/typed-response.ts";
import type {
  ApiDefinition,
  ApiErrorCodes,
  SchemaInput,
  SchemaOutput,
} from "../server/define-api.ts";
import type { BuiltinApiErrorCode } from "../server/api-error.ts";

/** True when `T` is `any`. */
export type IsAny<T> = 0 extends 1 & T ? true : false;

/** Anything shaped like a route handler (sync or async). */
export type HandlerLike = (...args: never[]) => Response | Promise<Response>;

/** The `{ def; result }` phantom a `defineApi` handler carries, or `never` for a plain one. */
export type ApiPhantom<H> = H extends { __api?: infer P } ? Exclude<P, undefined> : never;

/** A body type that is `any`/`unknown` carries no information → `never` (the key is omitted). */
export type Informative<B> = IsAny<B> extends true ? never : unknown extends B ? never : B;

/**
 * The JSON response body of a handler: a `defineApi` route's `response` schema output (or its
 * handler's non-`Response` return), else the `T` of a `TypedResponse<T>`, else `unknown`.
 */
export type HandlerResponse<H> = [ApiPhantom<H>] extends [never] ? PlainResponse<H>
  : ApiPhantom<H> extends { def: infer D; result: infer R }
    ? (D extends { response: infer S } ? SchemaOutput<S> : ValueResult<Awaited<R>>)
  : unknown;

/** A plain handler's response: the `T` of its `TypedResponse<T>` return, else `unknown`. */
export type PlainResponse<H> = H extends (...args: never[]) => infer R
  ? (Awaited<R> extends TypedResponse<infer T> ? Informative<T> extends never ? unknown : T
    : unknown)
  : unknown;

/** A `defineApi` handler's returned VALUE type (a returned `Response` carries no body type). */
export type ValueResult<R> = [Exclude<R, Response>] extends [never] ? unknown
  : Exclude<R, Response>;

/**
 * The JSON request body a handler expects: a `defineApi` route's `body` schema input, else the
 * `B` of a `TypedRequest<B>` first parameter, else `never` (no body key).
 */
export type HandlerBody<H> = [ApiPhantom<H>] extends [never] ? PlainBody<H>
  : ApiPhantom<H> extends { def: { body: infer S } } ? SchemaInput<S>
  : never;

/** A plain handler's request body: the `B` of its `TypedRequest<B>` first param, else `never`. */
export type PlainBody<H> = H extends (req: infer Q, ...rest: never[]) => unknown
  ? ([Q] extends [TypedRequest<infer B>] ? Informative<B> : never)
  : never;

/** The typed query record of a `defineApi` route (`query` schema input), else `never`. */
export type HandlerQuery<H> = [ApiPhantom<H>] extends [never] ? never
  : ApiPhantom<H> extends { def: { query: infer S } } ? SchemaInput<S>
  : never;

/**
 * The params the client must pass: a `defineApi` route's `params` schema input when declared,
 * else the pattern-derived record `P` (`{ id: string }`, `{ path: string[] }`).
 */
export type HandlerParams<H, P> = [ApiPhantom<H>] extends [never] ? P
  : ApiPhantom<H> extends { def: { params: infer S } } ? SchemaInput<S>
  : P;

/** The error codes a call may fail with: the endpoint's declared codes plus the builtins. */
export type HandlerErrors<H> = [ApiPhantom<H>] extends [never] ? BuiltinApiErrorCode
  : ApiPhantom<H> extends { def: infer D extends ApiDefinition }
    ? ApiErrorCodes<D> | BuiltinApiErrorCode
  : BuiltinApiErrorCode;

/**
 * One endpoint's schema entry. `params` / `body` / `query` keys are present ONLY when the
 * handler has them — the client's `RequestOf` keys its required-options logic on presence.
 */
export type InferEndpoint<H, P> =
  & ([HandlerParams<H, P>] extends [never] ? unknown : { params: HandlerParams<H, P> })
  & ([HandlerBody<H>] extends [never] ? unknown : { body: HandlerBody<H> })
  & ([HandlerQuery<H>] extends [never] ? unknown : { query: HandlerQuery<H> })
  & { response: HandlerResponse<H>; errors: HandlerErrors<H> };

/**
 * Every exported HTTP-method handler of a route module, as `{ GET: InferEndpoint; … }`. `P` is
 * the pattern-derived params record (`never` for a static route).
 *
 * @example
 * import type * as R0 from "../app/api/user/[id]/route.ts";
 * type UserEndpoints = ModuleEndpoints<typeof R0, { id: string }>;
 */
export type ModuleEndpoints<M, P = never> = {
  [K in keyof M & HttpMethod as M[K] extends HandlerLike ? K : never]: InferEndpoint<M[K], P>;
};
