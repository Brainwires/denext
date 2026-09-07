// Typed route handlers (2.0 Pillar V, network-boundary type safety).
//
// A route handler returns a `Response`, whose type carries no information about the
// JSON body it serialized — so a caller of `app/api/**/route.ts` gets `any` back, and a
// signature drift becomes a silent runtime 500. `TypedResponse<T>` and `TypedRequest<T>`
// close that gap: they are the SAME runtime objects as `Response`/`Request` (zero cost),
// but carry the body shape as a phantom type parameter. The typed-API-client generator
// (`src/build/api-types.ts`) reads those parameters back off each handler's signature and
// emits a fully-typed `apiClient`, so calling your own API is checked end-to-end with no
// extra dependency (no tRPC, no codegen client to import).
//
//   // app/api/user/[id]/route.ts
//   import { json, type TypedRequest, type TypedResponse } from "denext/server";
//   export function GET(_req: Request): TypedResponse<{ id: string; name: string }> {
//     return json({ id: "1", name: "Ada" });
//   }
//   export async function POST(req: TypedRequest<{ name: string }>): Promise<TypedResponse<{ ok: true }>> {
//     const body = await req.json(); // body: { name: string }
//     return json({ ok: true }, { status: 201 });
//   }
//
// The phantom carrier is a `readonly` optional field that never exists at runtime — it
// only marks the variance of `T`, so structural typing can recover it.

import { encodeWire, WIRE_HEADER } from "../runtime/wire-codec.ts";

/**
 * A `Response` that remembers the type of the JSON body it carries. Structurally a plain
 * `Response` at runtime; the `__body` phantom exists only in the type system so the
 * typed-API-client generator can recover `T`.
 */
export interface TypedResponse<T> extends Response {
  /** Phantom body-type carrier — never present at runtime. */
  readonly __body?: T;
}

/**
 * A `Request` whose `.json()` is typed to the body the handler expects. Structurally a
 * plain `Request`; `TBody` is recovered by the generator to type the client's request body.
 */
export interface TypedRequest<TBody> extends Request {
  /** Parse the request body as `TBody` (same runtime behavior as `Request.json`). */
  json(): Promise<TBody>;
  /** Phantom body-type carrier — never present at runtime. */
  readonly __reqBody?: TBody;
}

/**
 * Like `Response.json`, but the returned response remembers `T`. Use it in route handlers
 * so callers of the route get a typed body back through the generated `apiClient`. The body
 * goes through the wire codec: a Date / Map / Set / BigInt / undefined survives, and the
 * response carries `x-denext-wire: 1` only when a tag was needed (a plain-JSON body is
 * byte-identical to `Response.json`).
 *
 * @param data The value to serialize as the JSON body.
 * @param init Standard `ResponseInit` (status, headers, …).
 * @returns A `TypedResponse<T>` — a real `Response` carrying `T` as a phantom type.
 * @throws TypeError for a value the codec refuses (a function, a symbol, nesting past 64).
 */
export function json<T>(data: T, init?: ResponseInit): TypedResponse<T> {
  // Through the wire codec: a Date / Map / Set / BigInt / undefined survives, and the response
  // carries `x-denext-wire: 1` ONLY when a tag was needed — a plain-JSON body is byte-identical
  // to `Response.json(data)` and the typed client skips the decode walk.
  const { body, tagged } = encodeWire(data);
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (tagged) headers.set(WIRE_HEADER, "1");
  return new Response(body, { ...init, headers }) as TypedResponse<T>;
}
