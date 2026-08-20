// Resumable mode (SegmentConfig.resumable): every client island auto-defers to
// first-interaction hydration and plain function handlers are stamped so the client
// can resume-and-replay — plain components become resumable with no code changes.

// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { useEffect, useState } from "../src/runtime/hooks.ts";
import { readSegmentConfig } from "../src/server/segment-config.ts";
import type { VNode } from "../src/jsx/types.ts";

// A perfectly ordinary client component: useState + a plain onClick, no qrl, no
// client:* directive. Resumable mode must make it resumable unchanged.
function Counter(): VNode {
  const [n, setN] = useState(0);
  return h("button", { onClick: () => setN(n + 1) }, `count:${n}`);
}
const mod = { Counter };
tagClientExports(mod as Record<string, unknown>, "c_counter");

Deno.test("readSegmentConfig reads `export const resumable = true`", () => {
  assertEquals(readSegmentConfig({ resumable: true }).resumable, true);
  assertEquals(readSegmentConfig({}).resumable, false); // default off
});

Deno.test("resumable mode defers a handler-only island to interaction", async () => {
  const { islands } = await renderToHtmlFlight(h("main", null, h(Counter, {})), {
    resumable: true,
  });
  assertEquals(islands.length, 1);
  assertEquals(islands[0].strategy, "interaction");
});

Deno.test("resumable mode auto-picks idle for an effect-only island (Option A)", async () => {
  // A clock: interactive via useEffect, no handler. It must hydrate to tick, so it
  // can't wait for an interaction — resumable mode picks `idle`, not `interaction`.
  function Clock(): VNode {
    useEffect(() => {}, []);
    return h("time", null, "12:00");
  }
  const clockMod = { Clock };
  tagClientExports(clockMod as Record<string, unknown>, "c_clock");

  const { islands } = await renderToHtmlFlight(h("main", null, h(Clock, {})), {
    resumable: true,
  });
  assertEquals(islands.length, 1);
  assertEquals(islands[0].strategy, "idle");
});

Deno.test("an island with an effect AND a handler still picks idle (effects must run)", async () => {
  function Live(): VNode {
    useEffect(() => {}, []);
    return h("button", { onClick: () => {} }, "x");
  }
  const liveMod = { Live };
  tagClientExports(liveMod as Record<string, unknown>, "c_live");

  const { islands } = await renderToHtmlFlight(h("main", null, h(Live, {})), {
    resumable: true,
  });
  assertEquals(islands[0].strategy, "idle");
});

Deno.test("an island with neither effect nor handler falls back to idle", async () => {
  function Static(): VNode {
    return h("span", null, "hi");
  }
  const staticMod = { Static };
  tagClientExports(staticMod as Record<string, unknown>, "c_static");

  const { islands } = await renderToHtmlFlight(h("main", null, h(Static, {})), {
    resumable: true,
  });
  assertEquals(islands[0].strategy, "idle");
});

Deno.test("resumable mode stamps a plain function handler (data-dnx-h, no id)", async () => {
  const { html } = await renderToHtmlFlight(h("main", null, h(Counter, {})), {
    resumable: true,
  });
  assert(html.includes(`data-dnx-h="click"`), html);
});

Deno.test("without resumable mode, plain handlers are NOT stamped and islands stay eager", async () => {
  const { html, islands } = await renderToHtmlFlight(h("main", null, h(Counter, {})));
  assert(!html.includes("data-dnx-h"), html);
  assertEquals(islands.length, 0); // eager inline client ref, no directive
});

Deno.test("resumable mode carves the island to a foreign host (no up-front execution)", async () => {
  const { flight } = await renderToHtmlFlight(h("main", null, h(Counter, {})), {
    resumable: true,
  });
  // The page Flight references the island as a foreign <dnx-island> host with no
  // children — so the page root adopts DOM only, never running the component.
  const child = (flight as any).c[0];
  assertEquals(child.$, "h");
  assertEquals(child.t, "dnx-island");
  assertEquals(child.p.__dnxForeign, true);
  assertEquals(child.c, []);
});

Deno.test("an explicit client:* directive still wins over the resumable default", async () => {
  const { islands } = await renderToHtmlFlight(
    h("main", null, h(Counter, { "client:visible": true })),
    { resumable: true },
  );
  assertEquals(islands[0].strategy, "visible");
});
