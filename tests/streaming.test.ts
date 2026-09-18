// Incremental (Suspense) streaming for non-PPR routes (`streaming`).
// Streamed responses now carry the same strict hash-based CSP as buffered ones (the
// swap runtime is a hashed constant), so streaming is no longer gated by CSP. Covers:
// the head-collecting shell render, end-to-end streaming through createApp, the
// single swap runtime + streaming CSP, and a control signal thrown in the shell
// falling back to a buffered response.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { type HeadCollector, renderShell } from "../src/jsx/render-to-stream.ts";
import { SWAP_RUNTIME, SWAP_RUNTIME_BODY, swapRuntimeHash } from "../src/server/swap-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import { createResource, Suspense } from "../src/runtime/suspense.ts";
import { notFound, redirect } from "../src/runtime/error-boundary.ts";
import { after, cookies } from "../src/server/request-context.ts";
import { inMemoryCacheStore, PageCache, setCacheStore } from "../src/server/cache.ts";
import type { RouteManifest, SegmentLevel } from "../src/router/manifest.ts";
import type { PageProps } from "../src/server/types.ts";
import type { VNode } from "../src/jsx/types.ts";

/**
 * A one-page manifest. `levels` (a root segment level, as the scanner produces for any
 * app with a root layout) gives the tree its per-segment signal boundaries — the route's
 * `not-found.tsx` (`notFound`) or, at the root, the built-in not-found UI.
 */
function manifest(levels?: SegmentLevel[]): RouteManifest {
  const base = {
    kind: "page" as const,
    layoutChain: [],
    loading: null,
    error: null,
    notFound: null,
    forbidden: null,
    unauthorized: null,
    templateChain: [],
  };
  return {
    pages: [{
      ...base,
      pattern: parsePattern("/"),
      routePath: "/",
      filePath: "home.tsx",
      ...(levels ? { levels } : {}),
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
    directives: new Map(),
  };
}

function appWith(
  homeModule: unknown,
  extra: Record<string, unknown> = {},
  modules: Record<string, unknown> = {},
  levels?: SegmentLevel[],
) {
  return createApp({
    getManifest: () => manifest(levels),
    load: (fp: string) => Promise.resolve(fp === "home.tsx" ? homeModule : modules[fp]),
    ...extra,
  });
}

/** A root segment level with no files of its own (so its signal boundaries are the built-ins). */
const rootLevel = (notFound: string | null = null): SegmentLevel => ({
  depth: 0,
  layout: null,
  template: null,
  loading: null,
  error: null,
  notFound,
});

/** Read a streamed body chunk by chunk: `first()` the shell, then `rest()` to the end. */
function chunked(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  return {
    async first(): Promise<string> {
      const { value } = await reader.read();
      return decoder.decode(value);
    },
    async rest(): Promise<string> {
      let out = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return out;
        out += decoder.decode(value);
      }
    },
  };
}

/** The streamed replacement for hole `id`: the `<template data-dnx-r>`'s content, or null. */
function holeContent(html: string, id = "dnx0"): string | null {
  const m = new RegExp(`<template data-dnx-r="${id}"[^>]*>([\\s\\S]*?)</template>`).exec(html);
  return m ? m[1] : null;
}

// ---- head-collecting shell render ------------------------------------------

Deno.test("renderShell hoists in-tree <title>/<meta> out of the shell", async () => {
  const head: HeadCollector = { tags: [] };
  const sr = await renderShell(
    h(
      "div",
      null,
      h("title", null, "Hello"),
      h("meta", { name: "description", content: "d" }),
      h("p", null, "body"),
    ),
    head,
  );
  assertEquals(head.title, "Hello");
  assert(head.tags.some((t) => t.html.includes('name="description"')), "meta collected");
  assert(!sr.shell.includes("<title>"), "title hoisted out of the shell body");
  assertStringIncludes(sr.shell, "<p>body</p>");
});

// ---- end-to-end streaming --------------------------------------------------

Deno.test("streaming + csp:'off': a Suspense route streams shell then swaps in content", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => h("strong", null, read());
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));

  const app = appWith({ default: Page }, { streaming: true, csp: "off" });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-security-policy"), null, "streamed → no CSP");
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");

  queueMicrotask(() => resolveData("streamed!"));
  const html = await res.text();
  assertStringIncludes(html, 'data-dnx-b="dnx0"'); // shell placeholder
  assertStringIncludes(html, "Loading…"); // fallback in shell
  assertStringIncludes(html, "<strong>streamed!</strong>"); // streamed hole content
  assertStringIncludes(html, '<template data-dnx-r="dnx0">'); // hole streamed as a template
  // One swap runtime for the whole document; no per-hole inline script.
  assert(!html.includes("__dnxSwap"), "no per-hole swap script");
  assertEquals(html.split("MutationObserver").length - 1, 1, "exactly one swap runtime");
  assert(html.indexOf("Loading") < html.indexOf("streamed!"), "shell precedes hole");
});

Deno.test("streaming hoists a shell <title> into the streamed <head>", async () => {
  const Page = (_p: PageProps): VNode => h("div", null, h("title", null, "Streamed Title"), "hi");
  const app = appWith({ default: Page }, { streaming: true, csp: "off" });
  const res = await app(new Request("http://localhost/"));
  const html = await res.text();
  const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
  assertStringIncludes(head, "<title>Streamed Title</title>"); // hoisted into <head>
  assert(!html.slice(html.indexOf("<body>")).includes("<title>"), "not left in the body");
});

// ---- swap-runtime CSP hash stability ---------------------------------------

Deno.test("swap runtime: the authorized CSP hash is exactly sha256 of the emitted body", async () => {
  // The streamed response authorizes the inline swap script by hash, so the hash MUST
  // match the body actually emitted (recomputed here independently).
  const bytes = new TextEncoder().encode(SWAP_RUNTIME_BODY);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  assertEquals(await swapRuntimeHash(), `'sha256-${btoa(bin)}'`);
  // The <script> wraps exactly the hashed body (tags aren't part of the hash).
  assertStringIncludes(SWAP_RUNTIME, SWAP_RUNTIME_BODY);
  // The dev reveal-timeline tail is present but reads per-hole values at runtime
  // (getAttribute), so the body carries no per-hole literal — it stays a fixed constant.
  assertStringIncludes(SWAP_RUNTIME_BODY, "window.__denextDev");
  assertStringIncludes(SWAP_RUNTIME_BODY, "__denextBoundaries");
  assert(!/data-dnx-r="dnx/.test(SWAP_RUNTIME_BODY), "no per-hole id baked into the constant");
});

// ---- the streaming CSP -----------------------------------------------------

Deno.test("streaming under a strict CSP: streams AND carries the hash-based CSP", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => h("strong", null, read());
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));

  // Default global csp is "strict" — the route is still streamed, and the response
  // carries a strict CSP whose script-src includes the swap runtime's hash.
  const app = appWith({ default: Page }, { streaming: true });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  const csp = res.headers.get("content-security-policy");
  assert(csp, "streamed route keeps a CSP");
  assertStringIncludes(csp!, `script-src 'self' ${await swapRuntimeHash()}`);
  assertStringIncludes(csp!, "object-src 'none'");

  queueMicrotask(() => resolveData("streamed!"));
  const html = await res.text();
  assertStringIncludes(html, '<template data-dnx-r="dnx0">'); // still streamed
  assertStringIncludes(html, "<strong>streamed!</strong>");
  assert(!html.includes("__dnxSwap"), "no per-hole swap script");
});

// ---- control signal in the shell -------------------------------------------

Deno.test("notFound() during a streamed shell falls back to a buffered 404", async () => {
  const app = appWith(
    { default: () => notFound(), notFound: "nf.tsx" },
    { streaming: true, csp: "off" },
  );
  // The route has no nf.tsx module registered → default 404 UI, but crucially a 404
  // status (not a 200 stream): the control signal was caught before any flush.
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 404);
  const html = await res.text();
  // A control-signal page is buffered (renderDocument), not streamed: no swap
  // runtime and no streamed-hole template.
  assert(!html.includes("data-dnx-r"), "a control-signal page is buffered, not streamed");
  assert(!html.includes("MutationObserver"), "no swap runtime on a buffered page");
});

// ---- streaming is ON by default (promoted) ---------------------------------

Deno.test("streaming default-on: a Suspense route streams without opting in", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => h("strong", null, read());
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  // No `streaming` in the config — streaming is now the default.
  const app = appWith({ default: Page });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("cache-control") ?? "", "no-store");
  queueMicrotask(() => resolveData("hi"));
  const html = await res.text();
  assertStringIncludes(html, '<template data-dnx-r="dnx0">'); // streamed by default
  assertStringIncludes(html, "<strong>hi</strong>");
});

Deno.test("streaming default-on: a page with NO Suspense holes is buffered (cache-friendly)", async () => {
  // A fully synchronous page has nothing to stream, so it is delivered buffered:
  // no swap runtime, no streamed-hole template, and NOT marked no-store (so a
  // shared cache can still store it — streaming would have forced no-store).
  const Page = (_p: PageProps): VNode => h("main", null, h("h1", null, "static"));
  const app = appWith({ default: Page });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "<h1>static</h1>");
  assert(!html.includes("data-dnx-r"), "no streamed-hole template on a hole-less page");
  assert(!html.includes("MutationObserver"), "no swap runtime on a buffered page");
  assertEquals(res.headers.get("cache-control"), null); // not no-store → CDN-cacheable
});

Deno.test("streaming default-on: streaming:false opts out (buffered even with Suspense)", async () => {
  const read = createResource(() => Promise.resolve("done"));
  const Slow = (): VNode => h("strong", null, read());
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  const app = appWith({ default: Page }, { streaming: false });
  const res = await app(new Request("http://localhost/"));
  const html = await res.text();
  // Buffered: the boundary resolved server-side, no fallback/template shipped.
  assert(!html.includes("data-dnx-r"), "streaming:false → no streamed template");
  assert(!html.includes("Loading…"), "streaming:false → fallback resolved server-side");
  assertStringIncludes(html, "<strong>done</strong>");
});

// ---- control signals + request APIs INSIDE a streamed hole -----------------
//
// Inside a Suspense boundary that resolves after the shell flushed, the status line
// and headers are already on the wire. Next's semantics, matched here: `after()`
// still runs (when the stream ends), `redirect()` becomes a client-side redirect
// streamed into the hole, `notFound()` reveals the nearest not-found UI in place
// (status stays 200), and a cookie write is refused — loudly in dev.

Deno.test("after() inside a streamed hole runs exactly once, when the body has ended", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  let calls = 0;
  const Slow = (): VNode => {
    const v = read(); // suspends first; the retry (below) runs after the shell flushed
    after(() => {
      calls++;
    });
    return h("strong", null, v);
  };
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  const app = appWith({ default: Page }, { streaming: true, csp: "off" });
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  const body = chunked(res);
  const shell = await body.first();
  assertStringIncludes(shell, "Loading…");
  assertEquals(calls, 0, "not registered yet: the hole is still pending");
  resolveData("late");
  const tail = await body.rest();
  assertStringIncludes(tail, "<strong>late</strong>");
  assertEquals(calls, 1, "drained once, when the stream ended — not when the Response was made");
  // Nothing else drains it again later.
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(calls, 1);
});

Deno.test("redirect() inside a streamed hole streams a client-side redirect into the hole", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => {
    read();
    return redirect("/login?next=%2Fa&b=1"); // `await auth() ?? redirect("/login")`
  };
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  const app = appWith({ default: Page }, { streaming: true, csp: "off" }, {}, [rootLevel()]);
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200, "headers were committed with the shell");
  assertEquals(res.headers.get("location"), null);
  queueMicrotask(() => resolveData("x"));
  const html = await res.text();
  assertStringIncludes(html, "Loading…", "the shell still carries the fallback");
  const hole = holeContent(html);
  assert(hole !== null, "the hole IS replaced (not left as a failed hole)");
  assertEquals(
    hole,
    '<meta http-equiv="refresh" content="0;url=/login?next=%2Fa&amp;b=1">',
    "a meta refresh and nothing else — no inline script (blocked by the streaming CSP)",
  );
});

Deno.test("redirect() inside a streamed hole goes through the redirect sanitiser", async () => {
  const read = createResource(() => Promise.resolve("x"));
  const Slow = (): VNode => {
    read();
    return redirect("//evil.example/pwn"); // protocol-relative → pinned to this origin
  };
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  const app = appWith({ default: Page }, { streaming: true, csp: "off" });
  const html = await (await app(new Request("http://localhost/"))).text();
  assertEquals(
    holeContent(html),
    '<meta http-equiv="refresh" content="0;url=/evil.example/pwn">',
  );
});

Deno.test("notFound() inside a streamed hole reveals the route's not-found.tsx in place (200)", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => {
    read();
    return notFound();
  };
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  const NotFoundUi = (): VNode => h("section", { class: "nf" }, "Custom not found");
  const app = appWith(
    { default: Page },
    { streaming: true, csp: "off" },
    { "nf.tsx": { default: NotFoundUi } },
    [rootLevel("nf.tsx")],
  );
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200, "headers were committed with the shell (as in Next)");
  queueMicrotask(() => resolveData("x"));
  const html = await res.text();
  assertEquals(holeContent(html), '<section class="nf">Custom not found</section>');
  assertStringIncludes(html, "Loading…", "the shell's fallback is what the template replaces");
});

Deno.test("notFound() inside a streamed hole with no not-found.tsx reveals the built-in UI", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => {
    read();
    return notFound();
  };
  const Page = (_p: PageProps): VNode =>
    h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  const app = appWith({ default: Page }, { streaming: true, csp: "off" }, {}, [rootLevel()]);
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  queueMicrotask(() => resolveData("x"));
  const hole = holeContent(await res.text());
  assert(hole !== null, "the hole is replaced");
  assertStringIncludes(hole!, "<h1>404</h1>");
  assertStringIncludes(hole!, "This page could not be found.");
});

Deno.test("cookies().set() inside a streamed hole: throws in dev with the documented message", async () => {
  const g = globalThis as { __denextDev?: boolean };
  const prevDev = g.__denextDev;
  g.__denextDev = true;
  try {
    let resolveData: (v: string) => void = () => {};
    const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
    const Slow = (): VNode => {
      read();
      try {
        cookies().set("session", "abc");
        return h("i", null, "set went through");
      } catch (err) {
        return h("i", null, (err as Error).message);
      }
    };
    const Page = (_p: PageProps): VNode =>
      h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
    const app = appWith({ default: Page }, { streaming: true, csp: "off" });
    const res = await app(new Request("http://localhost/"));
    assertEquals(res.headers.get("set-cookie"), null, "nothing reached the response");
    queueMicrotask(() => resolveData("x")); // the hole settles after the headers went out
    const hole = holeContent(await res.text());
    assert(hole !== null);
    assertStringIncludes(
      hole!,
      "cookies can only be modified before the response starts — in a Server Action, a " +
        "Route Handler, middleware, or a component that renders before the first flush; " +
        "this component rendered inside a streamed Suspense boundary",
    );
  } finally {
    g.__denextDev = prevDev;
  }
});

Deno.test("cookies().set() inside a streamed hole: prod logs once and ignores the write", async () => {
  const g = globalThis as { __denextDev?: boolean };
  const prevDev = g.__denextDev;
  g.__denextDev = false;
  const origError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    let resolveData: (v: string) => void = () => {};
    const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
    const Slow = (): VNode => {
      read();
      cookies().set("a", "1");
      cookies().set("b", "2"); // a second write in the same request: no second log
      return h("i", null, "rendered");
    };
    const Page = (_p: PageProps): VNode =>
      h("div", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
    const app = appWith({ default: Page }, { streaming: true, csp: "off" });
    const res = await app(new Request("http://localhost/"));
    assertEquals(res.headers.get("set-cookie"), null);
    queueMicrotask(() => resolveData("x"));
    assertEquals(holeContent(await res.text()), "<i>rendered</i>", "the render itself succeeds");
    const cookieLogs = logged.filter((l) => l.includes("cookies can only be modified"));
    assertEquals(cookieLogs.length, 1, "logged once per request");
    assertStringIncludes(cookieLogs[0], "The write was ignored.");
  } finally {
    console.error = origError;
    g.__denextDev = prevDev;
  }
});

// Shell-time cookie writes are unaffected: the shell renders BEFORE the headers commit.
Deno.test("cookies().set() in the streamed SHELL still reaches the response", async () => {
  const read = createResource(() => Promise.resolve("x"));
  const Slow = (): VNode => h("strong", null, read());
  const Page = (_p: PageProps): VNode => {
    cookies().set("seen", "1");
    return h("div", null, h(Suspense, { fallback: h("p", null, "…"), children: h(Slow, null) }));
  };
  const app = appWith({ default: Page }, { streaming: true, csp: "off" });
  const res = await app(new Request("http://localhost/"));
  assertStringIncludes(res.headers.get("set-cookie") ?? "", "seen=1");
  await res.text();
});

Deno.test("PPR path: redirect() inside a resumed hole streams the client-side redirect", async () => {
  setCacheStore(inMemoryCacheStore());
  // cookies() postpones during the prerender, so the boundary is a per-request hole; on
  // resume the same component redirects — after the cached shell has flushed.
  const Slow = (): VNode => {
    if (!cookies().get("u")) return redirect("/login");
    return h("strong", null, `hi ${cookies().get("u")!.value}`);
  };
  const Page = (_p: PageProps): VNode =>
    h(
      "main",
      null,
      h("h1", null, "Shell"),
      h(Suspense, {
        fallback: h("p", null, "Loading…"),
        children: h(Slow, null),
      }),
    );
  const app = appWith(
    { default: Page, revalidate: 60 },
    { csp: "off", pageCache: new PageCache(), cacheComponents: true },
    {},
    [rootLevel()],
  );
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-denext-cache"), "MISS");
  const html = await res.text();
  assertStringIncludes(html, "<h1>Shell</h1>");
  assertEquals(holeContent(html), '<meta http-equiv="refresh" content="0;url=/login">');
  // A signed-in request resumes the same cached shell with real content.
  const res2 = await app(new Request("http://localhost/", { headers: { cookie: "u=ann" } }));
  assertEquals(res2.headers.get("x-denext-cache"), "HIT");
  assertEquals(holeContent(await res2.text()), "<strong>hi ann</strong>");
});

Deno.test("Flight path: redirect() inside a streamed hole streams the redirect; the tail Flight has no hole", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => {
    read();
    return redirect("/login");
  };
  const Page = (_p: PageProps): VNode =>
    h("main", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  const app = appWith(
    { default: Page },
    {
      streaming: true,
      csp: "off",
      flight: true,
      appDir: "/app",
      flightRoutes: new Set(["/"]),
      clientEntryFor: () => "/_denext/entry.js",
    },
    {},
    [rootLevel()],
  );
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  queueMicrotask(() => resolveData("x"));
  const html = await res.text();
  assertEquals(holeContent(html), '<meta http-equiv="refresh" content="0;url=/login">');
  const flightJson = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
  assert(!flightJson.includes(`"$":"$"`), "the hole is filled (with nothing) in the tail Flight");
});

Deno.test("Flight path: notFound() inside a streamed hole carries the not-found UI in the tail Flight", async () => {
  let resolveData: (v: string) => void = () => {};
  const read = createResource(() => new Promise<string>((r) => (resolveData = r)));
  const Slow = (): VNode => {
    read();
    return notFound();
  };
  const Page = (_p: PageProps): VNode =>
    h("main", null, h(Suspense, { fallback: h("p", null, "Loading…"), children: h(Slow, null) }));
  const app = appWith(
    { default: Page },
    {
      streaming: true,
      csp: "off",
      flight: true,
      appDir: "/app",
      flightRoutes: new Set(["/"]),
      clientEntryFor: () => "/_denext/entry.js",
    },
    {},
    [rootLevel()],
  );
  const res = await app(new Request("http://localhost/"));
  assertEquals(res.status, 200);
  queueMicrotask(() => resolveData("x"));
  const html = await res.text();
  const hole = holeContent(html);
  assert(hole !== null && hole.includes("<h1>404</h1>"), "the built-in UI streamed into the hole");
  const flightJson = /<script id="__denext_flight"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
  assertStringIncludes(flightJson, "This page could not be found.", "hydration sees the same UI");
});
