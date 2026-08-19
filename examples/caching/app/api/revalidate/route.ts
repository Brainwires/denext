// Tag invalidation endpoint. A native form POST (no client JS) hits this route,
// which purges the "products" cache tag and redirects back to the demo. In a real
// app you'd guard this (auth / a shared secret) — it's public here for the demo.

import { revalidateTag } from "denext/server";
import type { ApiContext } from "denext/server";

export async function POST(_req: Request, _ctx: ApiContext): Promise<Response> {
  await revalidateTag("products");
  // 303 so the browser follows with a GET after the POST.
  return new Response(null, { status: 303, headers: { location: "/data" } });
}
