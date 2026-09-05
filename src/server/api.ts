// Dispatch a request to an API route module's method handler.

import type { ApiMatch } from "../router/match.ts";
import type { ApiModule, HttpMethod, ModuleLoader } from "./types.ts";
import { readSegmentConfig } from "./segment-config.ts";
import { currentContext } from "./request-context.ts";
import { asyncProps } from "../runtime/async-props.ts";

const METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

/** Invoke the handler on an API module matching the request method. */
export async function handleApi(
  match: ApiMatch,
  request: Request,
  load: ModuleLoader,
): Promise<Response> {
  const mod = (await load(match.route.filePath)) as ApiModule;
  const method = request.method.toUpperCase() as HttpMethod;
  // Route segment config applies to handlers too: `dynamic = "error"` makes cookies()/
  // headers() throw, `force-static` makes them empty, and `revalidate` is honored by the
  // caller's cache flow — so record it on the request context like a page render does.
  const ctx = currentContext();
  if (ctx) ctx.segmentConfig = readSegmentConfig(mod);

  const handler = mod[method];
  if (handler) {
    return await handler(request, { params: asyncProps({ ...match.params }) });
  }

  // Auto-implement HEAD from GET when possible.
  if (method === "HEAD" && mod.GET) {
    const res = await mod.GET(request, { params: asyncProps({ ...match.params }) });
    // A HEAD response carries no body; cancel the GET's stream instead of dropping
    // it on the floor, which would leak the stream (and pin whatever backs it).
    await res.body?.cancel();
    return new Response(null, { status: res.status, headers: res.headers });
  }

  const allowed = METHODS.filter((m) => mod[m]).join(", ");
  return new Response("Method Not Allowed", {
    status: 405,
    headers: allowed ? { allow: allowed } : undefined,
  });
}
