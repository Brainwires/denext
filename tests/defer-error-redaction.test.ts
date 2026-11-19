// A rejected promise passed across the server/client boundary (a `defer()` field, a promise
// prop read with `use()`) serializes to the `<Await>` error marker. In production the marker
// carries what an error boundary would get — a generic message and a digest matching the server
// log — never the rejection's own text; development keeps the real message.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { renderToFlightStream } from "../src/jsx/render-to-flight-stream.ts";
import { deferErrorMarker } from "../src/jsx/flight-scalar.ts";
import { errorDigest } from "../src/runtime/error-boundary.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";

const DETAIL = "connect ECONNREFUSED db.internal:5432 (user app)";

const mod = { Island: (_p: Record<string, unknown>): VNode => h("i", null) };
tagClientExports(mod as Record<string, unknown>, "c_defer_redact");

function rejected(): Promise<unknown> {
  const p = Promise.reject(new Error(DETAIL));
  p.catch(() => {});
  return p;
}

/** Run `fn` with the dev flag set or cleared and `console.error` captured. */
async function withMode<T>(dev: boolean, fn: () => Promise<T>): Promise<{ out: T; log: string }> {
  const g = globalThis as { __denextDev?: boolean };
  const before = g.__denextDev;
  const original = console.error;
  let log = "";
  console.error = (...args: unknown[]) => void (log += args.map(String).join(" ") + "\n");
  if (dev) g.__denextDev = true;
  else delete g.__denextDev;
  try {
    return { out: await fn(), log };
  } finally {
    console.error = original;
    if (before === undefined) delete g.__denextDev;
    else g.__denextDev = before;
  }
}

Deno.test("defer error: production sends a generic message and the logged digest", async () => {
  const err = new Error(DETAIL);
  const { out, log } = await withMode(false, () => Promise.resolve(deferErrorMarker(err)));
  assertEquals(out, {
    __dnxAwaitError: true,
    message: "Internal Server Error",
    digest: errorDigest(err),
  });
  assertStringIncludes(log, errorDigest(err), "the server log has the digest");
  assertStringIncludes(log, DETAIL, "and the real error");
});

Deno.test("defer error: no production serializer puts the rejection's text on the wire", async () => {
  const tree = () => h(mod.Island, { data: { slow: rejected() }, direct: rejected() });
  const { out } = await withMode(false, async () => [
    JSON.stringify(await renderToFlight(tree())),
    JSON.stringify(await renderToHtmlFlight(tree())),
    await new Response(renderToFlightStream(tree())).text(),
  ]);
  for (const wire of out) {
    assertStringIncludes(wire, "__dnxAwaitError");
    assertStringIncludes(wire, "Internal Server Error");
    assert(!wire.includes("ECONNREFUSED") && !wire.includes("db.internal"));
  }
});

Deno.test("defer error: development keeps the real message", async () => {
  const { out } = await withMode(
    true,
    async () => JSON.stringify(await renderToFlight(h(mod.Island, { data: rejected() }))),
  );
  assertStringIncludes(out, DETAIL);
});
