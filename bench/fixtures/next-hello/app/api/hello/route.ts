// API route /api/hello — mirrors examples/hello/app/api/hello/route.ts.
export function GET(request: Request): Response {
  const name = new URL(request.url).searchParams.get("name") ?? "world";
  return Response.json({ message: `Hello, ${name}!`, runtime: "node" });
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  return Response.json({ youSent: body }, { status: 201 });
}
