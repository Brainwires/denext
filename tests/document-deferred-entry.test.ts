// Which script a Flight page loads: the deferred boot (`flight-boot.js`) when its only client
// code is islands that wait for a trigger, else the Flight entry (server/document.ts).

import { assertStringIncludes } from "@std/assert";
import { type DocumentOptions, renderDocument } from "../src/server/document.ts";
import type { IslandPayload } from "../src/jsx/render-shared.ts";

const ISLAND = `<div data-dnx-island data-dnx-id="0-1" data-dnx-strategy="interaction" ` +
  `style="display:contents"><div class="card"><button type="button" data-dnx-h="click">` +
  `0</button></div></div>`;

function entryOf(opts: Partial<DocumentOptions>): string {
  const html = renderDocument({
    bodyHtml: `<main><h1>Title</h1>${ISLAND}<p>after</p></main>`,
    metadata: {},
    hydration: { params: {}, searchParams: "", pathname: "/" },
    clientEntry: "/_denext/client/flight.js",
    deferredEntry: "/_denext/client/flight-boot.js",
    flight: "static text", // a page root with nothing to hydrate: inlined as null
    islands: [island("interaction")],
    ...opts,
  });
  return /<script type="module" src="([^"]+)"><\/script>/.exec(html)![1];
}

function island(strategy: IslandPayload["strategy"]): IslandPayload {
  return { id: "0-1", strategy, flight: null };
}

const BOOT = "/_denext/client/flight-boot.js";
const ENTRY = "/_denext/client/flight.js";

Deno.test("a page of deferred islands loads the deferred boot", () => {
  assertStringIncludes(entryOf({}), BOOT);
  for (const s of ["idle", "visible", "media"] as const) {
    assertStringIncludes(entryOf({ islands: [island("interaction"), island(s)] }), BOOT);
  }
  // A handler inside an island (a nested div closes before it) is the island's own.
  assertStringIncludes(
    entryOf({ bodyHtml: `<main>${ISLAND}<div><span>x</span></div></main>` }),
    BOOT,
  );
});

Deno.test("a page that needs the runtime at once loads the Flight entry", () => {
  // A page root to hydrate (a client component outside every island).
  assertStringIncludes(entryOf({ flight: { $: "c", i: "c_1#X", p: {}, c: [] } }), ENTRY);
  // An island that does not wait.
  assertStringIncludes(entryOf({ islands: [island("interaction"), island("load")] }), ENTRY);
  assertStringIncludes(entryOf({ islands: [island("only")] }), ENTRY);
  // No islands at all, or no boot written (dev, an instrumentation-client).
  assertStringIncludes(entryOf({ islands: [] }), ENTRY);
  assertStringIncludes(entryOf({ deferredEntry: undefined }), ENTRY);
  // A resumable handler outside every island: a <Link>'s soft navigation.
  assertStringIncludes(
    entryOf({
      bodyHtml: `<main>${ISLAND}<a href="/next" data-dnx-h="mouseenter click">next</a></main>`,
    }),
    ENTRY,
  );
  assertStringIncludes(
    entryOf({ bodyHtml: `<div data-dnx-h="click">x</div>${ISLAND}` }),
    ENTRY,
  );
});
