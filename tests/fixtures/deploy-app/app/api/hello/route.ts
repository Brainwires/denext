// A route handler with two methods.
export function GET(): Response {
  return Response.json({ hello: Deno.env.get("GREETING") ?? "world" });
}
export async function POST(request: Request): Promise<Response> {
  return Response.json(await request.json());
}
