// Smoke test for examples/streaming: build + serve it, then assert (1) the
// buffered page path fully resolves its Suspense'd async Server Components before
// delivering HTML, and (2) the /stream route truly streams — flushing the shell +
// fallback first, then swapping in the boundary's content out of order.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { build } from "../../src/build/build.ts";
import { startProdServer } from "../../src/build/prod-server.ts";

const APP = new URL("../../examples/streaming", import.meta.url).pathname;

Deno.test({
  name:
    "examples/streaming: buffered Suspense resolution + out-of-order streaming",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const controller = new AbortController();
  let server: Deno.HttpServer | undefined;
  try {
    await build(APP);

    const { promise, resolve } = Promise.withResolvers<
      { hostname: string; port: number }
    >();
    server = await startProdServer({
      projectDir: APP,
      port: 0,
      hostname: "127.0.0.1",
      signal: controller.signal,
      onListen: (info) => resolve(info),
    });
    const { hostname, port } = await promise;
    const origin = `http://${hostname}:${port}`;

    await t.step(
      "the dashboard resolves its async Server Components (buffered)",
      async () => {
        const html = await (await fetch(`${origin}/dashboard`)).text();
        // Both widgets' resolved data is present…
        assertStringIncludes(html, "$48,210");
        assertStringIncludes(html, "1,204");
        // …and the Suspense fallbacks are NOT in the buffered HTML (they resolved server-side).
        assert(
          !html.includes("Loading sales…"),
          "buffered SSR must not ship the fallback",
        );
      },
    );

    await t.step(
      "/stream flushes the shell + fallback before the resolved boundary",
      async () => {
        const res = await fetch(`${origin}/stream`);
        assertStringIncludes(
          res.headers.get("content-type") ?? "",
          "text/html",
        );
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        // First chunk = the shell. It must carry the fallback but NOT the resolved
        // report (which is still pending on a 400ms delay).
        const first = await reader.read();
        const firstText = decoder.decode(first.value);
        assertStringIncludes(firstText, "Generating report…");
        assert(
          !firstText.includes("Report ready"),
          "the resolved boundary must not be in the shell chunk",
        );

        // Drain the rest; a later chunk swaps in the resolved content via a template.
        let rest = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          rest += decoder.decode(value);
        }
        assertStringIncludes(rest, "Report ready");
        assertStringIncludes(rest, "data-dnx-r"); // the out-of-order swap template

        // Ordering holds across the whole stream: fallback precedes resolved content.
        const full = firstText + rest;
        assert(
          full.indexOf("Generating report…") < full.indexOf("Report ready"),
          "the fallback must appear before the streamed-in content",
        );
      },
    );
  } finally {
    controller.abort();
    await server?.finished;
  }
});
