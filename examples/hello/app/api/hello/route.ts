// API route: /api/hello — exports one handler per HTTP method.

import type { ApiContext } from "denext/server";

export function GET(request: Request, _ctx: ApiContext): Response {
  const name = new URL(request.url).searchParams.get("name") ?? "world";
  return Response.json({ message: `Hello, ${name}!`, runtime: "deno" });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  return Response.json({ youSent: body }, { status: 201 });
}
