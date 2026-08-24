// The server side of the devtools render-mode glass-box: the document renderer
// serializes the request context's render mode (static/dynamic/streamed + cache)
// into a dev-only `#__denext_render_modes` JSON island the panel reads. Emitted only
// under `__denextDev`; never in production.

import { assert, assertStringIncludes } from "@std/assert";
import { renderDocument } from "../src/server/document.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

function doc(pathname: string): Parameters<typeof renderDocument>[0] {
  return {
    bodyHtml: "<main>hi</main>",
    metadata: {},
    hydration: { params: {}, searchParams: "", pathname },
    clientEntry: "/entry.js",
  };
}

Deno.test("document: emits the dev render-mode island from the request context", () => {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  g.__denextDev = true;
  try {
    const ctx = createRequestContext(new Request("http://x/p"));
    ctx.renderStreamed = true;
    ctx.renderCache = "MISS";
    const html = runWithContext(ctx, () => renderDocument(doc("/p")));
    assertStringIncludes(html, 'id="__denext_render_modes"');
    assertStringIncludes(html, '"mode":"streamed"');
    assertStringIncludes(html, '"cache":"MISS"');
    assertStringIncludes(html, '"route":"/p"');
  } finally {
    if (prev === undefined) delete g.__denextDev;
    else g.__denextDev = prev;
  }
});

Deno.test("document: mode reflects usedDynamicApi when not streamed", () => {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  g.__denextDev = true;
  try {
    const dyn = createRequestContext(new Request("http://x/d"));
    dyn.usedDynamicApi = true;
    assertStringIncludes(runWithContext(dyn, () => renderDocument(doc("/d"))), '"mode":"dynamic"');

    const stat = createRequestContext(new Request("http://x/s"));
    assertStringIncludes(runWithContext(stat, () => renderDocument(doc("/s"))), '"mode":"static"');
  } finally {
    if (prev === undefined) delete g.__denextDev;
    else g.__denextDev = prev;
  }
});

Deno.test("document: omits the render-mode island in production", () => {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  delete g.__denextDev;
  try {
    const ctx = createRequestContext(new Request("http://x/p"));
    ctx.renderStreamed = true;
    const html = runWithContext(ctx, () => renderDocument(doc("/p")));
    assert(!html.includes("__denext_render_modes"), "no dev island in production");
  } finally {
    if (prev !== undefined) g.__denextDev = prev;
  }
});
