// `rateLimitHeader` / `rateLimitLocalAddresses` end to end through the REAL production server:
// a small app (a Flight page, so the Live hub is mounted; a `rateLimit()` route; denextAuth with a
// sign-in budget) is built, then `startProdServer` serves it on 127.0.0.1 — so every request
// arrives from a real loopback socket peer, exactly as behind a reverse proxy on the same host.
//
//   1. `rateLimitHeader: "x-real-ip"` in denext.config.ts: each address the header names has its
//      own `rateLimit()` bucket, sign-in budget and `live.limits.maxConnectionsPerIp` slot; a
//      request without the header falls back to the loopback rule (skipped, not one site-wide
//      bucket) and the server warns.
//   2. The same build restarted with `DENEXT_RATE_LIMIT_LOCAL_ADDRESSES=1` (config > env > off):
//      the loopback peer itself is now limited by its own address on all three.
//
// The fixture is written under examples/ (so its `../../mod.ts` imports resolve) and removed
// afterwards.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { build } from "../../src/build/build.ts";
import { startProdOrigin } from "../helpers/prod-origin.ts";
import { resetLimitHeaderWarningForTesting } from "../../src/server/remote-addr.ts";

const APP = fromFileUrl(new URL("../../examples/.rate-limit-header-test", import.meta.url));

const FILES: Record<string, string> = {
  "deno.json": JSON.stringify(
    {
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "denext",
        lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      },
      imports: {
        "denext": "../../mod.ts",
        "denext/jsx-runtime": "../../src/jsx/jsx-runtime.ts",
        "denext/jsx-dev-runtime": "../../src/jsx/jsx-runtime.ts",
        "denext/server": "../../src/server/mod.ts",
        "denext/client": "../../src/client/mod.ts",
      },
    },
    null,
    2,
  ),
  "denext.config.ts": `import { denextAuth, github } from "denext/server";
export default {
  rateLimitHeader: "x-real-ip",
  live: { limits: { maxConnectionsPerIp: 1 } },
  plugins: [
    denextAuth({
      secret: "rate-limit-header-secret-at-least-32-chars",
      providers: [github({ clientId: "client-123", clientSecret: "shh" })],
      rateLimit: { signin: { max: 1, windowMs: 60_000 } },
    }),
  ],
};
`,
  "app/layout.tsx": `export default function Layout({ children }: { children: unknown }) {
  return <html><body>{children}</body></html>;
}
`,
  "app/counter.tsx": `"use client";
import { useState } from "denext";
export function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{n}</button>;
}
`,
  "app/page.tsx": `import { Counter } from "./counter.tsx";
export default function Page() {
  return <main><Counter /></main>;
}
`,
  "app/api/limited/route.ts": `import { createApi, rateLimit } from "denext/server";
export const GET = createApi().use(rateLimit({ max: 1, windowMs: 60_000 })).define({}, () => "ok");
`,
};

/** Each request's status (bodies drained). */
async function statuses(origin: string, path: string, headers: Record<string, string>[]) {
  const out: number[] = [];
  for (const h of headers) {
    const res = await fetch(`${origin}${path}`, { headers: h, redirect: "manual" });
    await res.body?.cancel();
    out.push(res.status);
  }
  return out;
}

/** Open a Live socket (same-origin), resolving with it, or `null` when the upgrade is refused. */
function openLive(origin: string, headers: Record<string, string> = {}): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${origin.replace("http", "ws")}/_denext/live`, {
      headers: { origin, ...headers },
    } as unknown as string[]);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => resolve(null);
  });
}

/** Run `fn` with `console.warn` captured; resolves with what it logged. */
async function capturingWarnings(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

Deno.test({
  name: "prod server: rateLimitHeader and rateLimitLocalAddresses key every per-address limit",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  await Deno.remove(APP, { recursive: true }).catch(() => {});
  for (const [file, text] of Object.entries(FILES)) {
    await Deno.mkdir(join(APP, file, ".."), { recursive: true });
    await Deno.writeTextFile(join(APP, file), text);
  }
  const sockets: WebSocket[] = [];
  try {
    await build(APP);

    await t.step("rateLimitHeader (config): each named client has its own budgets", async () => {
      resetLimitHeaderWarningForTesting();
      const controller = new AbortController();
      const { origin, server } = await startProdOrigin(APP, controller.signal);
      try {
        const a = { "x-real-ip": "198.51.100.10" };
        const b = { "x-real-ip": "2001:db8:1:2::a" };
        const b2 = { "x-real-ip": "2001:db8:1:2::b" }; // the same /64
        // rateLimit(): one request per client; another client, and the /64, are their own.
        assertEquals(await statuses(origin, "/api/limited", [a, a, b, b2]), [200, 429, 200, 429]);
        // denextAuth's sign-in budget, the same way.
        assertEquals(await statuses(origin, "/auth/signin/github", [a, a, b]), [303, 429, 303]);
        // Live: one socket per client.
        const first = await openLive(origin, a);
        assert(first, "the first socket of client a opens");
        sockets.push(first);
        assertEquals(await openLive(origin, a), null, "a second socket of client a is refused");
        const other = await openLive(origin, { "x-real-ip": "198.51.100.11" });
        assert(other, "another client behind the same proxy gets its own slot");
        sockets.push(other);
        // Without the header: the loopback peer is not one shared bucket (it is skipped) — warned.
        const warnings = await capturingWarnings(async () => {
          assertEquals(await statuses(origin, "/api/limited", [{}, {}, {}]), [200, 200, 200]);
        });
        assert(warnings.some((w) => w.includes("x-real-ip")), warnings.join("\n"));
      } finally {
        for (const ws of sockets.splice(0)) ws.close();
        controller.abort();
        await server.finished;
      }
    });

    await t.step(
      "rateLimitLocalAddresses (env): the loopback peer is limited by its own address",
      async () => {
        Deno.env.set("DENEXT_RATE_LIMIT_LOCAL_ADDRESSES", "1");
        const controller = new AbortController();
        const { origin, server } = await startProdOrigin(APP, controller.signal);
        try {
          await capturingWarnings(async () => {
            assertEquals(await statuses(origin, "/api/limited", [{}, {}]), [200, 429]);
            assertEquals(await statuses(origin, "/auth/signin/github", [{}, {}]), [303, 429]);
            const first = await openLive(origin);
            assert(first, "the loopback peer's first socket opens");
            sockets.push(first);
            assertEquals(await openLive(origin), null, "its second is refused");
            // A named client still has its own bucket (the header outranks the peer).
            const named = { "x-real-ip": "198.51.100.20" };
            assertEquals(await statuses(origin, "/api/limited", [named]), [200]);
          });
        } finally {
          Deno.env.delete("DENEXT_RATE_LIMIT_LOCAL_ADDRESSES");
          for (const ws of sockets.splice(0)) ws.close();
          controller.abort();
          await server.finished;
        }
      },
    );
  } finally {
    await Deno.remove(APP, { recursive: true }).catch(() => {});
  }
});
