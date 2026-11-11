// Fresh's partial navigation wiring (`denext/fresh/partial`): the document listeners a
// `<Partial>` installs, driven with the events a browser dispatches, in a child process with a
// stand-in `document` (tests/helpers/fresh-partial-dom.ts) so no other test sees those globals.
// A `<button f-partial>` swaps its region without a history entry; a client-nav link fetches
// its `f-partial` URL, appends to its region and pushes its `href`; GET and POST forms submit
// their fields (replacing the history entry); a redirect with no partials is followed; and what Fresh leaves to the browser
// (`f-client-nav="false"`, no `f-partial`, a cancelled click, a fragment link, a form naming no
// target, a `dialog` form) is left alone.

import { assert, assertEquals } from "@std/assert";
import { inChild } from "./helpers/isolated.ts";
import type { PartialHistoryReport, PartialNavReport } from "./helpers/fresh-partial-dom.ts";

Deno.test("partial navigation: buttons, links and forms fetch and swap their regions", async () => {
  const { value: r } = await inChild<PartialNavReport>({
    imports: `import { runPartialNavScenarios } from "@repo/tests/helpers/fresh-partial-dom.ts";`,
    body: "return await runPartialNavScenarios();",
  });
  assertEquals(r.fetched, [
    { url: "/parts/recipe?fresh-partial=true", method: "get", body: null, nav: "1" },
    { url: "/parts/more?fresh-partial=true", method: "get", body: null, nav: "1" },
    { url: "/search?q=lemon&fresh-partial=true", method: "get", body: null, nav: "1" },
    { url: "/save?fresh-partial=true", method: "post", body: "n,1", nav: "1" },
    { url: "/moved?fresh-partial=true", method: "post", body: "", nav: "1" },
    { url: "/hop?fresh-partial=true", method: "get", body: null, nav: "1" },
  ]);
  assertEquals(r.html[6], "foundsaved+one+two", "an answer from another origin is never applied");
  assertEquals(r.html.slice(0, 5), [
    "Lemonadeone", // the button replaced "recipe"
    "Lemonadeone", // the link click alone (before denext's navigation asks)
    "Lemonadeone+two", // the link appended to "list"
    "foundone+two", // the GET form
    "foundsaved+one+two", // the POST form prepended
  ]);
  // A link pushes its href; a form replaces the entry with its action, as Fresh does.
  assertEquals(r.pushed, ["http://app.test/?page=2"]);
  // The first swap marks the entry it shows (same URL), so back / forward can find it again.
  assertEquals(r.replaced, ["http://app.test/", "http://app.test/search", "http://app.test/"]);
  assertEquals(
    r.assigned,
    ["http://app.test/landed", "https://other.example/landed"],
    "a redirect is followed in full, and one to another origin too",
  );
  assertEquals(r.title, "Answered");
  assertEquals(r.ignored, 0, "nothing else was fetched");
  assertEquals(r.foreign, [], "a cross-origin f-partial is never fetched");
  assert(r.declined.every((u) => u.startsWith("/?page=3")), r.declined.join());
});

Deno.test("partial navigation: head merge, view transitions and back / forward", async () => {
  const { value: r } = await inChild<PartialHistoryReport>({
    imports:
      `import { runPartialHistoryScenarios } from "@repo/tests/helpers/fresh-partial-dom.ts";`,
    body: "return await runPartialHistoryScenarios();",
  });
  // The answer's head merged into the page's: a <meta> updated by name and one added by
  // property; the charset, an existing stylesheet, a non-stylesheet link and an <svg>'s content
  // left alone; the new stylesheet added (and waited for) before the region swapped.
  assertEquals(r.head, [
    "meta name=description content=new",
    "meta charset=utf-8",
    "link rel=stylesheet href=/a.css",
    "meta property=og:title content=Styled",
    "link rel=stylesheet href=/b.css crossorigin=anonymous",
  ]);
  assertEquals([r.whileLoading, r.afterLoad], ["one", "styled"]);
  // Under f-view-transition the swap ran in document.startViewTransition; elsewhere not.
  assertEquals(r.transitions, [1, 1]);
  assertEquals(r.steps, [
    "one+two", // link to ?page=2 appended
    "one+two+three", // link to ?page=3 appended
    "one+two", // back: the region as ?page=2 left it, with no request
    "one", // back to the first entry
    "one+two+three", // forward
    "one+two+three", // a pop that is not partial navigation's: left to the next claim
    "fetched", // an entry with no record here: fetched, its region replaced (not appended)
  ]);
  assertEquals(r.claims, [true, true, true, "next:", true]);
  assertEquals(r.fetched, [
    "/parts/styled?fresh-partial=true",
    "/parts/plain?fresh-partial=true",
    "/parts/two?fresh-partial=true",
    "/parts/three?fresh-partial=true",
    "/?page=9&fresh-partial=true",
  ]);
});
