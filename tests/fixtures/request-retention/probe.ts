// Run with --v8-flags=--expose-gc (tests/request-retention.test.ts does). Serves requests through
// examples/hello's app handler and reports how many of the finished requests and responses a
// forced GC leaves alive: whatever the server keeps per request (a map keyed by request, a cached
// response, a captured async context, a renderer left installed) keeps them. Prints one JSON line.
import { fromFileUrl } from "@std/path";
import { createTestApp } from "../../../src/testing/mod.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --v8-flags=--expose-gc");

async function collect(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    gc!();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const HELLO = fromFileUrl(new URL("../../../examples/hello", import.meta.url));
const ROUNDS = Number(Deno.args[0] ?? 40);
// A streamed page with an island, a static page, an async server component, a route handler and
// a 404.
const PATHS = ["/", "/about", "/blog/hello", "/api/hello", "/missing"];

const app = await createTestApp(HELLO);
const requests: WeakRef<Request>[] = [];
const responses: WeakRef<Response>[] = [];
const statuses = new Set<number>();
async function serve(path: string, track: boolean): Promise<void> {
  const request = new Request(`http://localhost${path}`, {
    headers: { "accept-encoding": "gzip", cookie: "session=visitor" },
  });
  const response = await app(request);
  statuses.add(response.status);
  await response.arrayBuffer();
  if (track) {
    requests.push(new WeakRef(request));
    responses.push(new WeakRef(response));
  }
}
// Warm every route first (module loads, first-render caches); track only the later requests.
for (const path of PATHS) await serve(path, false);
for (let i = 0; i < ROUNDS; i++) await serve(PATHS[i % PATHS.length], true);
await collect();
const aliveAt = (refs: WeakRef<object>[]) =>
  refs.flatMap((r, i) => r.deref() ? [PATHS[i % PATHS.length]] : []);
console.log(JSON.stringify({
  served: requests.length,
  requestsAlive: aliveAt(requests),
  responsesAlive: aliveAt(responses),
  statuses: [...statuses].sort(),
}));
await app.close();
