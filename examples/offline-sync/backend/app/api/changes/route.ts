// GET /api/changes?since=<checkpoint>: the rows changed since the device's last checkpoint.
// This half is the example's own; under PowerSync, the PowerSync Service streams changes to the
// client from the database's replication log instead.

import { changesSince } from "../../../lib/store.ts";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const raw = new URL(request.url).searchParams.get("since") ?? "0";
  const since = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(since)) {
    return Response.json({ error: "since must be a non-negative integer" }, {
      status: 400,
    });
  }
  return Response.json(changesSince(since), {
    headers: { "cache-control": "no-store" },
  });
}
