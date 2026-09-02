// API route: /api/hello — exports one handler per HTTP method.
//
// These handlers use denext's typed helpers (`json` + `TypedResponse`/`TypedRequest` from
// `denext/server`) so `denext dev` / `denext build` can generate a fully-typed client for
// this route in `.denext/api.ts`:
//
//   import { createApiClient } from "denext";
//   import type { ApiSchema } from "../../.denext/api.ts";
//   const api = createApiClient<ApiSchema>();
//   const { message } = await api("/api/hello", "GET", { query: { name: "Ada" } });
//   const echoed = await api("/api/hello", "POST", { body: { a: 1 } });
//
// `json(...)` is `Response.json(...)` at runtime — the typing is zero-cost.

import { type ApiContext, json, type TypedRequest, type TypedResponse } from "denext/server";

export function GET(
  request: Request,
  _ctx: ApiContext,
): TypedResponse<{ message: string; runtime: "deno" }> {
  const name = new URL(request.url).searchParams.get("name") ?? "world";
  return json({ message: `Hello, ${name}!`, runtime: "deno" });
}

export async function POST(
  request: TypedRequest<Record<string, unknown>>,
): Promise<TypedResponse<{ youSent: Record<string, unknown> }>> {
  const body = await request.json().catch(() => ({}));
  return json({ youSent: body }, { status: 201 });
}
