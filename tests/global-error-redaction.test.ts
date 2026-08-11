// SRV-M1: the error handed to global-error.tsx is redacted in production (generic
// message + digest) so it can't leak internals to clients; the real error shows in
// dev and always goes to the server log.

import { assert, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderGlobalError } from "../src/server/render-page.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import type { VNode } from "../src/jsx/types.ts";

const manifest = { rootGlobalError: "global-error.tsx" } as unknown as RouteManifest;

// A global-error component that (unsafely) renders the raw message — the exact
// pattern that would leak internals.
const load = (_fp: string) =>
  Promise.resolve({
    default: (p: { error: Error & { digest?: string } }): VNode =>
      h("p", null, `error: ${p.error.message}${p.error.digest ? ` (${p.error.digest})` : ""}`),
  });

const SECRET = "connect ECONNREFUSED db-prod:5432 password=hunter2";

Deno.test("production redacts the error message and adds a digest", async () => {
  const g = globalThis as { __denextDev?: boolean };
  delete g.__denextDev;
  const origError = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => void logged.push(a);
  try {
    const r = await renderGlobalError(manifest, load, new Error(SECRET));
    assert(r, "rendered");
    assert(!r!.html.includes(SECRET), "the internal detail is NOT sent to the client");
    assertStringIncludes(r!.html, "Internal Server Error");
    // The full error is still logged (with a digest for correlation).
    assert(
      logged.some((a) => JSON.stringify(a).includes("digest")),
      "the real error is logged with a digest",
    );
  } finally {
    console.error = origError;
  }
});

Deno.test("dev shows the real error for debugging", async () => {
  const g = globalThis as { __denextDev?: boolean };
  g.__denextDev = true;
  try {
    const r = await renderGlobalError(manifest, load, new Error(SECRET));
    assertStringIncludes(r!.html, SECRET);
  } finally {
    delete g.__denextDev;
  }
});
