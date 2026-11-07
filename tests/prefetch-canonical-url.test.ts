// U10 (#105): soft-nav prefetches ask for the URL the server serves the page at. The server 308s
// every page URL to its `trailingSlash` spelling (`/today` → `/today/` with it on, `/docs/` →
// `/docs` with it off), so a prefetch of the other spelling was fetched twice; and a same-page
// hash link (`/#about` on `/`) prefetched the page that is already showing.
//
// The browser globals (`location`, `document`, `fetch`) are stubbed per test and restored, as
// tests/client-nav-coverage.test.ts does.

import { assertEquals } from "@std/assert";
import { prefetch } from "../src/client/navigation.ts";
import { navData, type PageRequest } from "../src/server/page-document.ts";

// deno-lint-ignore no-explicit-any
type AnyGlobal = any;

/**
 * Run `fn` on a page at `href` whose hydration data is `data`, recording every fetched URL.
 * Each call uses its own document, so the hydration data is read again.
 */
async function onPage(
  href: string,
  data: Record<string, unknown> | null,
  fn: () => void,
): Promise<string[]> {
  const g = globalThis as AnyGlobal;
  const saved = { location: g.location, document: g.document, fetch: g.fetch };
  const fetched: string[] = [];
  const url = new URL(href);
  g.location = { href, origin: url.origin, pathname: url.pathname, search: url.search };
  g.document = {
    getElementById: (id: string) =>
      id === "__denext_data" && data ? { textContent: JSON.stringify(data) } : null,
  };
  g.fetch = (input: string) => {
    fetched.push(String(input));
    return Promise.resolve(new Response("<html></html>"));
  };
  try {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete g[key];
      else g[key] = value;
    }
  }
  return fetched;
}

Deno.test("trailingSlash on: a prefetch asks for the slash form, once for both spellings", async () => {
  const fetched = await onPage("http://localhost/", { trailingSlash: true }, () => {
    prefetch("/u10-today");
    prefetch("/u10-today/");
  });
  assertEquals(fetched, ["http://localhost/u10-today/"]);
});

Deno.test("trailingSlash off (the default): a prefetch drops the trailing slash", async () => {
  const fetched = await onPage("http://localhost/", {}, () => {
    prefetch("/u10-docs/");
    prefetch("/u10-docs");
  });
  assertEquals(fetched, ["http://localhost/u10-docs"]);
});

Deno.test("files, framework paths and the root keep their spelling, as the server's rule does", async () => {
  const fetched = await onPage("http://localhost/elsewhere/", { trailingSlash: true }, () => {
    prefetch("/u10-report.pdf");
    prefetch("/_denext/u10-x");
    prefetch("/?u10-root");
  });
  assertEquals(fetched, [
    "http://localhost/u10-report.pdf",
    "http://localhost/_denext/u10-x",
    "http://localhost/?u10-root",
  ]);
});

Deno.test("the search survives the slash change; the hash is not part of the fetch", async () => {
  const fetched = await onPage("http://localhost/", { trailingSlash: true }, () => {
    prefetch("/u10-search?q=1#top");
  });
  assertEquals(fetched, ["http://localhost/u10-search/?q=1"]);
});

Deno.test("a hash link to the page that is showing is not prefetched", async () => {
  const home = await onPage("http://localhost/u10-home", {}, () => {
    prefetch("/u10-home#about");
    prefetch("#pricing");
  });
  assertEquals(home, []);
  // Under trailingSlash the page is at /u10-home/, and /u10-home#about is the same page.
  const slashed = await onPage("http://localhost/u10-home/", { trailingSlash: true }, () => {
    prefetch("/u10-home#about");
  });
  assertEquals(slashed, []);
  // Another page's hash, or the same path with another query, is still prefetched (once per
  // page, whichever hash the links carry).
  const other = await onPage("http://localhost/u10-home", {}, () => {
    prefetch("/u10-elsewhere#about");
    prefetch("/u10-elsewhere#team");
    prefetch("/u10-home?tab=2#about");
  });
  assertEquals(other, ["http://localhost/u10-elsewhere", "http://localhost/u10-home?tab=2"]);
});

Deno.test("a page without hydration data (no denext server rendered it) keeps every URL as written", async () => {
  const fetched = await onPage("http://localhost/", null, () => {
    prefetch("/u10-spa/");
    prefetch("/u10-spa-plain");
  });
  assertEquals(fetched, ["http://localhost/u10-spa/", "http://localhost/u10-spa-plain"]);
});

Deno.test("the hydration data carries trailingSlash only when it is on", () => {
  const pr = (trailingSlash?: boolean) =>
    ({
      page: { params: {} },
      state: {
        url: new URL("http://localhost/x/"),
        pathname: "/x/",
        app: { basePath: "", config: { trailingSlash } },
        ctx: {},
      },
    }) as unknown as PageRequest;
  assertEquals(navData(pr(true)).trailingSlash, true);
  assertEquals("trailingSlash" in navData(pr(false)), false);
  assertEquals("trailingSlash" in navData(pr(undefined)), false);
});
