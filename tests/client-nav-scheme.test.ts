// A programmatic navigation never hands `location` a script URL: `navigate()` (what
// `router.push` and a `<Link>` click call), a `redirect()` thrown in a client render or an
// event handler, and the Pages Router's own navigations all refuse `javascript:` / `vbscript:`
// / `data:` while still loading any other cross-origin URL in full.

import { assert, assertEquals } from "@std/assert";
import { isScriptUrl } from "../src/client/nav-scheme.ts";
import { navigate } from "../src/client/navigation.ts";
import { handleEventError } from "../src/client/fiber/boundaries.ts";
import { handleThrow } from "../src/client/fiber/unwind.ts";
import { redirect } from "../src/runtime/error-boundary.ts";
import { navigate as pagesNavigate } from "../packages/pages-router/src/client-runtime.ts";
import type { Fiber } from "../src/client/fiber/fiber.ts";

const SCRIPT_URLS = [
  "javascript:void 0",
  "JavaScript:void 0",
  " \tjava\nscript:void 0",
  "vbscript:x",
  "data:text/html,x",
];

/** Run `fn` with a recording `location`; resolves to what it was asked to load. */
async function withLocation(fn: () => unknown): Promise<string[]> {
  const g = globalThis as { location?: unknown };
  const before = Object.getOwnPropertyDescriptor(globalThis, "location");
  const loaded: string[] = [];
  const current = "https://app.test/page";
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    writable: true,
    value: {
      get href() {
        return current;
      },
      set href(url: string) {
        loaded.push(url);
      },
      origin: "https://app.test",
      pathname: "/page",
      search: "",
      hash: "",
      assign: (url: string) => void loaded.push(url),
      replace: (url: string) => void loaded.push(url),
      reload() {},
    },
  });
  try {
    await fn();
  } finally {
    if (before) Object.defineProperty(globalThis, "location", before);
    else delete g.location;
  }
  return loaded;
}

/** What `redirect(url)` throws. */
function thrownRedirect(url: string): unknown {
  try {
    redirect(url);
  } catch (err) {
    return err;
  }
}

Deno.test("isScriptUrl: script schemes as the browser parses them, nothing else", async () => {
  await withLocation(() => {
    for (const url of SCRIPT_URLS) assert(isScriptUrl(url), url);
    for (
      const url of ["/next", "next?a=javascript:1", "https://other.example/", "mailto:a@b.c", "#x"]
    ) {
      assert(!isScriptUrl(url), url);
    }
  });
});

Deno.test("navigate: a script URL goes nowhere; another origin still loads in full", async () => {
  for (const url of SCRIPT_URLS) {
    assertEquals(await withLocation(() => navigate(url)), [], url);
  }
  assertEquals(
    await withLocation(() => navigate("https://other.example/x")),
    ["https://other.example/x"],
  );
});

Deno.test("client redirect(): a script URL is not followed from a render or an event handler", async () => {
  const fiber = {} as Fiber;
  for (const url of SCRIPT_URLS) {
    const loaded = await withLocation(() => {
      handleThrow(fiber, thrownRedirect(url));
      handleEventError(fiber, thrownRedirect(url));
    });
    assertEquals(loaded, [], url);
  }
  const loaded = await withLocation(() => {
    handleThrow(fiber, thrownRedirect("/login"));
    handleEventError(fiber, thrownRedirect("https://other.example/sso"));
  });
  assertEquals(loaded, ["/login", "https://other.example/sso"]);
});

Deno.test("pages router: navigate refuses a script URL and loads another origin in full", async () => {
  for (const url of SCRIPT_URLS) {
    assertEquals(await withLocation(() => pagesNavigate(url, {})), [], url);
  }
  assertEquals(
    await withLocation(() => pagesNavigate("https://other.example/x", {})),
    ["https://other.example/x"],
  );
});
