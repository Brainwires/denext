// Opt-in in-process concurrency ceiling (AppConfig.maxConcurrency): a request that
// arrives while `maxConcurrency` others are already in flight is shed immediately
// with 503 + Retry-After (fast-fail, never queued). A slot is held from arrival
// until the response is produced and released on every exit path, so a follow-up
// request succeeds once earlier ones complete. Default (unset) = no limit.

import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";

function pageManifest(): RouteManifest {
  const base = {
    kind: "page" as const,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  return {
    pages: [
      { ...base, pattern: parsePattern("slow"), routePath: "/slow", filePath: "slow.tsx" },
    ],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

/** A gated async page: every render blocks until `open()` is called. */
function gatedApp(maxConcurrency?: number) {
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  const modules: Record<string, unknown> = {
    "slow.tsx": {
      default: async () => {
        await gate;
        return h("h1", null, "ok");
      },
    },
  };
  const app = createApp({
    getManifest: pageManifest,
    load: (fp) => Promise.resolve(modules[fp]),
    maxConcurrency,
  });
  return { app, open };
}

Deno.test("maxConcurrency sheds the over-limit request with 503 + Retry-After, then releases", async () => {
  const { app, open } = gatedApp(2);

  // Two requests claim both slots (they block on the gate, holding the slots).
  const p1 = app(new Request("http://localhost/slow"));
  const p2 = app(new Request("http://localhost/slow"));
  // The third arrives at capacity → shed immediately, without waiting on the gate.
  const shed = await app(new Request("http://localhost/slow"));

  assertEquals(shed.status, 503, "the over-limit request is shed");
  assertEquals(shed.headers.get("retry-after"), "1", "with a Retry-After hint");
  await shed.body?.cancel();

  // Let the two in-flight requests complete, releasing their slots.
  open();
  const [r1, r2] = await Promise.all([p1, p2]);
  assertEquals(r1.status, 200);
  assertEquals(r2.status, 200);
  assert((await r1.text()).includes("ok"));
  assert((await r2.text()).includes("ok"));

  // A follow-up now finds free slots and succeeds.
  const { app: app2, open: open2 } = gatedApp(2);
  open2();
  const r4 = await app2(new Request("http://localhost/slow"));
  assertEquals(r4.status, 200, "a request succeeds once slots are free");
  await r4.body?.cancel();
});

Deno.test("no ceiling by default: many concurrent requests all succeed", async () => {
  const { app, open } = gatedApp(); // unset → unlimited
  const reqs = Array.from({ length: 8 }, () => app(new Request("http://localhost/slow")));
  open();
  const reses = await Promise.all(reqs);
  for (const r of reses) {
    assertEquals(r.status, 200);
    await r.body?.cancel();
  }
});
