// `notFound()` / `forbidden()` / `unauthorized()` thrown by a Server Action the browser calls
// render the nearest `not-found.tsx` / `forbidden.tsx` / `unauthorized.tsx`, as in Next.js:
//   • the browser dispatch (src/client/action-dispatch.ts) re-raises the reply's `signal` as the
//     branded error `notFound()` throws (Next's `NEXT_HTTP_ERROR_FALLBACK;<status>` digest), not
//     a plain `Error("notFound")` that the error boundary rendered;
//   • the client tree hands an access signal that reaches it (an event handler's rejection,
//     `useActionState`) to the client runtime's handler instead of throwing it uncaught;
//   • a soft navigation carrying `x-denext-signal` renders the route with that signal raised at
//     the page: the nearest signal file under the layouts, with the signal's status, never cached.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, SEPARATOR } from "@std/path";
import { dispatchAction } from "../src/client/action-dispatch.ts";
import { decodeWire } from "../src/runtime/wire-codec.ts";
import { prepareWire } from "../src/runtime/wire-encode.ts";
import {
  ErrorBoundary,
  isForbidden,
  isNotFound,
  isUnauthorized,
  notFound,
  redirect,
  unstable_rethrow,
} from "../src/runtime/error-boundary.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { raiseAccessSignal, setAccessSignalHandler } from "../src/client/fiber/boundaries.ts";
import { useActionState } from "../src/runtime/actions.ts";
import { installFormActions } from "../src/client/dom-props.ts";
import { scanRoutes } from "../src/router/manifest.ts";
import { createApp } from "./helpers/released-app.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

await installFormActions();

// ---- the browser dispatch ---------------------------------------------------------------

/** Dispatch one action whose endpoint answers `reply` with `status`. */
async function dispatchAnswered(reply: unknown, status: number): Promise<unknown> {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(reply), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    return await dispatchAction("a#gone", [], null, decodeWire, prepareWire);
  } finally {
    globalThis.fetch = original;
  }
}

/** The error a dispatch rejected with. */
async function rejection(reply: unknown, status: number): Promise<Error & { digest?: string }> {
  try {
    await dispatchAnswered(reply, status);
  } catch (err) {
    return err as Error & { digest?: string };
  }
  throw new Error("the dispatch resolved");
}

Deno.test("an action's notFound() reaches the caller as the branded not-found signal", async () => {
  const err = await rejection({ error: "notFound", signal: "notFound" }, 404);
  assert(isNotFound(err), "isNotFound() recognizes it");
  assertEquals(err.message, "NEXT_NOT_FOUND");
  assertEquals(err.name, "NotFoundError");
  assertEquals(err.digest, "NEXT_HTTP_ERROR_FALLBACK;404");
  // A catch-all in the caller passes it on, as it does for the signal thrown in a render.
  let rethrown: unknown;
  try {
    unstable_rethrow(err);
  } catch (e) {
    rethrown = e;
  }
  assertEquals(rethrown, err);
});

Deno.test("an action's forbidden() / unauthorized() reach the caller branded too", async () => {
  const f = await rejection({ error: "forbidden", signal: "forbidden" }, 403);
  assert(isForbidden(f));
  assert(!isNotFound(f as unknown));
  assertEquals([f.message, f.name, f.digest], [
    "NEXT_FORBIDDEN",
    "ForbiddenError",
    "NEXT_HTTP_ERROR_FALLBACK;403",
  ]);
  const u = await rejection({ error: "unauthorized", signal: "unauthorized" }, 401);
  assert(isUnauthorized(u));
  assertEquals([u.message, u.name, u.digest], [
    "NEXT_UNAUTHORIZED",
    "UnauthorizedError",
    "NEXT_HTTP_ERROR_FALLBACK;401",
  ]);
});

Deno.test("a reply's unknown signal is an ordinary failure", async () => {
  for (const signal of ["__proto__", "constructor", "redirect"]) {
    const err = await rejection({ error: "server action failed", signal }, 500);
    assert(!isNotFound(err) && !isForbidden(err) && !isUnauthorized(err), signal);
    assertEquals(err.message, "server action failed");
  }
});

Deno.test("a redirect reply still navigates and resolves undefined", async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  const loc = { href: "http://localhost/" };
  Object.defineProperty(globalThis, "location", { value: loc, configurable: true });
  try {
    assertEquals(await dispatchAnswered({ redirect: "/done" }, 200), undefined);
    assertEquals(loc.href, "/done");
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had);
    else delete (globalThis as Record<string, unknown>).location;
  }
});

// ---- the client tree --------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Run `body` with an access-signal handler that records the statuses it is handed. */
async function withSignalHandler(
  body: (seen: string[]) => Promise<void> | void,
): Promise<void> {
  const seen: string[] = [];
  setAccessSignalHandler((status) => void seen.push(status));
  try {
    await body(seen);
  } finally {
    setAccessSignalHandler(null);
  }
}

/** The error a dispatch re-raises for the reply's `signal`. */
const signalOf = (signal: string, status: number) => rejection({ error: signal, signal }, status);

Deno.test("an event handler's rejected access signal goes to the client's signal handler", async () => {
  const sig = await signalOf("notFound", 404);
  await withSignalHandler(async (seen) => {
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    const root = createRoot(asEl(container));
    root.render(h("button", { onClick: () => Promise.reject(sig) }, "go"));
    flushSync();
    (container.childNodes[0] as FakeElement).dispatch("click");
    await tick();
    assertEquals(seen, ["404"]);
    assertEquals((container.childNodes[0] as FakeElement).textContent, "go", "the DOM stays");
    root.unmount();
  });
});

Deno.test("useActionState re-raising an action's forbidden() goes to the signal handler", async () => {
  const sig = await signalOf("forbidden", 403);
  await withSignalHandler(async (seen) => {
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    function Form(): VNode {
      const [msg, submit] = useActionState<string, unknown>(() => Promise.reject(sig), "idle");
      return h("form", { action: submit }, h("output", null, msg));
    }
    const root = createRoot(asEl(container));
    root.render(h(Form, null));
    flushSync();
    const form = container.childNodes[0] as FakeElement;
    form.dispatch("submit");
    await tick();
    await tick();
    flushSync();
    assertEquals(seen, ["403"]);
    assertEquals((form.childNodes[0] as FakeElement).textContent, "idle", "render abandoned");
    root.unmount();
  });
});

Deno.test("useActionState rethrows an action's ordinary error into the error boundary", async () => {
  const { doc, container } = makeDom();
  setDocument(asDoc(doc));
  function Form(): VNode {
    const [msg, submit] = useActionState<string, unknown>(
      () => Promise.reject(new Error("db down")),
      "idle",
    );
    return h("form", { action: submit }, h("output", null, msg));
  }
  const root = createRoot(asEl(container));
  root.render(
    h(ErrorBoundary, {
      fallback: ({ error }: { error: Error }) => h("p", null, "caught:" + error.message),
      children: h(Form, null),
    }),
  );
  flushSync();
  const g = globalThis as { __denextDev?: boolean };
  g.__denextDev = true; // the boundary sees the real message
  try {
    (container.childNodes[0] as FakeElement).dispatch("submit");
    await tick();
    await tick();
    flushSync();
    assertEquals((container.childNodes[0] as FakeElement).textContent, "caught:db down");
  } finally {
    delete g.__denextDev;
    root.unmount();
  }
});

Deno.test("a client render's own notFound() still ends the render; redirect() is never handed over", async () => {
  await withSignalHandler((seen) => {
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    function Item({ gone }: { gone: boolean }): VNode {
      if (gone) notFound();
      return h("p", null, "item");
    }
    const root = createRoot(asEl(container));
    root.render(h(Item, { gone: false }));
    flushSync();
    let thrown: unknown;
    try {
      root.render(h(Item, { gone: true }));
      flushSync();
    } catch (e) {
      thrown = e;
    }
    assert(isNotFound(thrown), "a server-side signal: the client render ends (KNOWN-DIFFERENCES)");
    assertEquals(seen, []);
    root.unmount();
    let redirected: unknown;
    try {
      redirect("/x");
    } catch (e) {
      redirected = e;
    }
    assertEquals(raiseAccessSignal(redirected), false);
    assertEquals(seen, []);
  });
});

// ---- the server render of a raised signal ------------------------------------------------

/** An app dir of `files` (stub sources) whose modules come from `mods`. */
async function scannedApp(files: string[], mods: Record<string, unknown>) {
  const dir = await Deno.makeTempDir({ prefix: "denext_raised_sig_" });
  for (const rel of files) {
    const full = join(dir, rel);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, "export default function(){}\n");
  }
  const manifest = await scanRoutes(dir);
  const app = createApp({
    getManifest: () => manifest,
    load: (fp) => {
      const slashed = fp.split(SEPARATOR).join("/");
      const key = Object.keys(mods).filter((k) => slashed.endsWith("/" + k))
        .sort((a, b) => b.length - a.length)[0];
      return Promise.resolve(key ? mods[key] : undefined);
    },
  });
  return { dir, app };
}

type P = { children?: VNode };
const FILES = [
  "layout.tsx",
  "shop/layout.tsx",
  "shop/not-found.tsx",
  "shop/forbidden.tsx",
  "shop/item/not-found.tsx",
  "shop/item/page.tsx",
];
const MODS: Record<string, unknown> = {
  "layout.tsx": { default: (p: P) => h("html", null, h("body", null, "root:", p.children)) },
  "shop/layout.tsx": { default: (p: P) => h("section", null, "shop-layout:", p.children) },
  "shop/not-found.tsx": { default: () => h("h1", null, "shop-not-found") },
  "shop/forbidden.tsx": { default: () => h("h1", null, "shop-forbidden") },
  "shop/item/not-found.tsx": { default: () => h("h1", null, "item-not-found") },
  "shop/item/page.tsx": { default: () => h("p", null, "item-page") },
};

/** A soft navigation to `/shop/item` asking for `signal` (none when null). */
const softNav = (signal: string | null, nav = true) =>
  new Request("http://localhost/shop/item", {
    headers: {
      ...(nav ? { "x-denext-nav": "1" } : {}),
      ...(signal ? { "x-denext-signal": signal } : {}),
    },
  });

Deno.test("a soft nav raising 404 renders the page level's not-found under the layouts", async () => {
  const { dir, app } = await scannedApp(FILES, MODS);
  try {
    const res = await app(softNav("404"));
    assertEquals(res.status, 404);
    assertStringIncludes(res.headers.get("cache-control") ?? "", "no-store");
    const html = await res.text();
    assertStringIncludes(html, "root:<section>shop-layout:<h1>item-not-found</h1>");
    assert(!html.includes("item-page"), "the page itself does not render");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a soft nav raising 403 / 401 renders the nearest forbidden / unauthorized UI", async () => {
  const { dir, app } = await scannedApp(FILES, MODS);
  try {
    const f = await app(softNav("403"));
    assertEquals(f.status, 403);
    assertStringIncludes(await f.text(), "shop-layout:<h1>shop-forbidden</h1>");
    const u = await app(softNav("401"));
    assertEquals(u.status, 401);
    assertStringIncludes(await u.text(), "You must be signed in to view this page.");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("x-denext-signal is honoured only on a soft nav, and only for an access status", async () => {
  const { dir, app } = await scannedApp(FILES, MODS);
  try {
    for (
      const req of [softNav("404", false), softNav("500"), softNav("__proto__"), softNav(null)]
    ) {
      const res = await app(req);
      assertEquals(res.status, 200);
      assertStringIncludes(await res.text(), "<p>item-page</p>");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
