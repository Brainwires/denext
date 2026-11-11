// Releases the /deferred page's slow value (app/slow-gate.ts): the e2e test fetches it once
// the fast value is on screen. Answers how many renders were waiting.
import { releaseSlow } from "../slow-gate.ts";

export function POST(): Response {
  return Response.json({ released: releaseSlow() });
}
