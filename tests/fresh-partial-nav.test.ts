// Fresh's partial navigation wiring (`denext/fresh/partial`): the document listeners a
// `<Partial>` installs, driven with the events a browser dispatches, in a child process with a
// stand-in `document` (tests/helpers/fresh-partial-dom.ts) so no other test sees those globals.
// A `<button f-partial>` swaps its region without a history entry; a client-nav link fetches
// its `f-partial` URL, appends to its region and pushes its `href`; GET and POST forms submit
// their fields (replacing the history entry); a redirect with no partials is followed; and what Fresh leaves to the browser
// (`f-client-nav="false"`, no `f-partial`, a cancelled click, a fragment link, a form naming no
// target, a `dialog` form) is left alone.

import { assertEquals } from "@std/assert";
import { inChild } from "./helpers/isolated.ts";
import type { PartialNavReport } from "./helpers/fresh-partial-dom.ts";

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
  ]);
  assertEquals(r.html.slice(0, 5), [
    "Lemonadeone", // the button replaced "recipe"
    "Lemonadeone", // the link click alone (before denext's navigation asks)
    "Lemonadeone+two", // the link appended to "list"
    "foundone+two", // the GET form
    "foundsaved+one+two", // the POST form prepended
  ]);
  // A link pushes its href; a form replaces the entry with its action, as Fresh does.
  assertEquals(r.pushed, ["http://app.test/?page=2"]);
  assertEquals(r.replaced, ["http://app.test/search", "http://app.test/"]);
  assertEquals(r.assigned, ["http://app.test/landed"], "the redirect is followed in full");
  assertEquals(r.title, "Answered");
  assertEquals(r.ignored, 0, "nothing else was fetched");
});
