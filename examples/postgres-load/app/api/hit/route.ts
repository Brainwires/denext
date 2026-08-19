// The endpoint the load harness hammers: one write + one count per request, each
// borrowing and releasing a pooled Postgres connection. Under concurrency higher
// than POOL_SIZE, requests queue for a free client — they do NOT open unbounded
// connections — which is exactly the behavior the load test verifies.

import { initDb, recordVisit } from "../../../lib/db.ts";

export async function POST(): Promise<Response> {
  await initDb();
  const total = await recordVisit("/api/hit");
  return Response.json({ ok: true, total });
}

// A GET returns the current total (handy for a quick curl / health check).
export async function GET(): Promise<Response> {
  await initDb();
  const total = await recordVisit("/api/hit (GET)");
  return Response.json({ ok: true, total });
}
