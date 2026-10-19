// POST /api/data: apply a device's queued writes. The body is PowerSync's upload shape
// (`{ batch: [{ op, table, id, data }] }`, see src/protocol.ts), so a real PowerSync client's
// `uploadData` can post here too. A malformed batch is a 400 and nothing of it is applied.
// An app with users checks the session here and scopes every row to its owner.

import { parseUpload } from "../../../../src/protocol.ts";
import { applyBatch } from "../../../lib/store.ts";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = parseUpload(body);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  return Response.json({ checkpoint: applyBatch(parsed.batch) });
}
