// Line-coverage sweep of the `denext/remix` CLIENT runtime (`src/compat/remix/client.ts`):
// the navigation/data/submission hooks and components a migrated Remix app imports from
// `@remix-run/react`. Each hook/component is driven through the denext render harness (so
// effects + events run) with a probe component that captures the hook's value, and the
// browser globals (`location`/`history`/`fetch`) are stubbed + restored in a `finally`.

import { assert, assertEquals } from "@std/assert";
import { h } from "denext/jsx-runtime";
import { render, waitFor } from "denext/testing";
import { Suspense } from "../mod.ts";
import {
  Await,
  type Blocker,
  Form,
  Link,
  Links,
  LiveReload,
  Meta,
  NavLink,
  Outlet,
  OutletProvider,
  PrefetchPageLinks,
  RemixBrowser,
  RemixErrorProvider,
  RemixRouteProvider,
  RemixServer,
  Scripts,
  ScrollRestoration,
  useActionData,
  useAsyncError,
  useAsyncValue,
  useBlocker,
  useFetcher,
  useFormAction,
  useHref,
  useLocation,
  useNavigate,
  useNavigation,
  useOutletContext,
  useResolvedPath,
  useRevalidator,
  useRouteError,
  useRouteLoaderData,
  useSearchParams,
  useSubmit,
} from "../src/compat/remix/client.ts";
import { navigate } from "../src/client/navigation.ts";

// ── Global stubbing helper ────────────────────────────────────────────────────

interface Stubs {
  location?: unknown;
  history?: unknown;
  fetch?: unknown;
}
type G = Record<string, unknown>;

/** Install `over` onto globalThis and return a restore fn (undefined originals are deleted). */
function stub(over: Stubs): () => void {
  const g = globalThis as unknown as G;
  const keys = ["location", "history", "fetch"] as const;
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = g[k];
  for (const k of keys) {
    if (k in over) g[k] = (over as G)[k];
  }
  return () => {
    for (const k of keys) {
      if (orig[k] === undefined) delete g[k];
      else g[k] = orig[k];
    }
  };
}

/** A location object rich enough for the hooks that read it. */
function fakeLocation(path = "/here", search = "", hash = "") {
  return {
    href: `http://x${path}${search}${hash}`,
    origin: "http://x",
    pathname: path,
    search,
    hash,
    replace() {},
  };
}

/** A fetch that records the call and hangs — proves a nav proceeded without a DOMParser path. */
function hangingFetch(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fn = ((input: unknown) => {
    calls.push(String(input));
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Wrap children in a route so the route-context hooks (useSubmit/useActionData/Form) resolve. */
let routeSeq = 0;
function route(
  opts: { id?: string; formAction?: (fd: FormData) => Promise<unknown>; children: unknown },
) {
  return h(RemixRouteProvider, {
    // A fresh id per route keeps the module-level action-data store isolated between tests.
    id: opts.id ?? `routes/test-${++routeSeq}`,
    loaderData: { seeded: true },
    params: { city: "berlin" },
    formAction: opts.formAction,
    children: opts.children,
  } as never);
}

// ── Inert document components ──────────────────────────────────────────────────

Deno.test("inert document components render nothing / passthrough", async () => {
  // Meta/Links/Scripts/ScrollRestoration/LiveReload/PrefetchPageLinks return null; the
  // Remix{Browser,Server} entries pass their children through a fragment.
  assertEquals(Meta(), null);
  assertEquals(Links(), null);
  assertEquals(Scripts(), null);
  assertEquals(ScrollRestoration(), null);
  assertEquals(LiveReload(), null);
  assertEquals(PrefetchPageLinks(), null);

  const screen = await render(
    h("div", null, [
      h(RemixBrowser, { children: h("span", null, "b") }),
      h(RemixServer, { children: h("i", null, "s") }),
    ]),
  );
  assert(screen.html().includes("b"));
  assert(screen.html().includes("s"));
});

// ── Data hooks ──────────────────────────────────────────────────────────────

Deno.test("useRouteLoaderData reads a specific ancestor route's data by id", async () => {
  let got: unknown;
  const Probe = () => {
    got = useRouteLoaderData("routes/loader-target");
    return h("p", null, "ok");
  };
  await render(route({ id: "routes/loader-target", children: h(Probe, null) }));
  assertEquals(got, { seeded: true });
});

Deno.test("useRouteError exposes the caught error from RemixErrorProvider", async () => {
  let got: unknown;
  const Probe = () => {
    got = useRouteError();
    return h("p", null, "ok");
  };
  await render(h(RemixErrorProvider, { error: new Error("boom"), children: h(Probe, null) }));
  assert(got instanceof Error);
  assertEquals((got as Error).message, "boom");
});

// ── Navigation hooks ──────────────────────────────────────────────────────────

Deno.test("useNavigation returns a valid state at rest (idle when nothing is pending)", async () => {
  // Placed before any navigating test so, run in isolation, the global navigating signal is
  // null and this exercises the idle return path.
  let nav: ReturnType<typeof useNavigation> | undefined;
  const Probe = () => {
    nav = useNavigation();
    return h("p", null, nav.state);
  };
  await render(h(Probe, null));
  assert(["idle", "loading", "submitting"].includes(nav!.state));
});

Deno.test("useNavigation reports loading with the target location during a soft nav", async () => {
  const { fetch } = hangingFetch();
  const restore = stub({ location: fakeLocation("/a"), fetch });
  try {
    let nav: ReturnType<typeof useNavigation> | undefined;
    const Probe = () => {
      nav = useNavigation();
      return h("p", null, nav.state);
    };
    await render(h(Probe, null));
    void navigate("/dest?q=1");
    await waitFor(() => assertEquals(nav?.state, "loading"));
    assertEquals(nav?.location?.pathname, "/dest");
    assertEquals(nav?.location?.search, "?q=1");
  } finally {
    restore();
  }
});

Deno.test("useLocation builds a Remix location from pathname/search/history.state", async () => {
  const restore = stub({
    location: fakeLocation("/notes", "", "#frag"),
    history: { state: { usr: { from: "here" } } },
  });
  try {
    let loc: ReturnType<typeof useLocation> | undefined;
    const Probe = () => {
      loc = useLocation();
      return h("p", null, loc.pathname);
    };
    await render(h(Probe, null));
    assertEquals(loc?.hash, "#frag");
    assertEquals(loc?.state, { from: "here" });
    assertEquals(loc?.key, "default");
  } finally {
    restore();
  }
});

Deno.test("useNavigate: a path pushes/replaces; a number goes through history", async () => {
  let delta: number | undefined;
  const { fetch } = hangingFetch();
  const restore = stub({
    location: fakeLocation("/a"),
    history: { go: (n: number) => (delta = n) },
    fetch,
  });
  try {
    let nav: ReturnType<typeof useNavigate> | undefined;
    const Probe = () => {
      nav = useNavigate();
      return h("p", null, "ok");
    };
    const screen = await render(h(Probe, null));
    await screen.act(() => {
      nav!(-2); // history delta
      nav!("/push"); // router.push → navigate
      nav!("/replace", { replace: true }); // router.replace
    });
    assertEquals(delta, -2);
  } finally {
    restore();
  }
});

Deno.test("useSearchParams setParams navigates for URLSearchParams, record, and updater forms", async () => {
  const { fetch, calls } = hangingFetch();
  const restore = stub({ location: fakeLocation("/search"), fetch });
  try {
    let setP: ReturnType<typeof useSearchParams>[1] | undefined;
    const Probe = () => {
      const [, set] = useSearchParams();
      setP = set;
      return h("p", null, "ok");
    };
    const screen = await render(h(Probe, null));
    await screen.act(() => setP!(new URLSearchParams("a=1")));
    await screen.act(() => setP!({ b: "2" }));
    await screen.act(() => setP!((prev) => new URLSearchParams(prev.toString() + "&c=3")));
    await screen.act(() => setP!(new URLSearchParams(""), { replace: true })); // empty qs → bare path
    assert(calls.some((c) => c.includes("a=1")));
    assert(calls.some((c) => c.includes("b=2")));
  } finally {
    restore();
  }
});

Deno.test("useNavigation reports the in-flight submission (submitting)", async () => {
  const { fetch } = hangingFetch();
  const restore = stub({ location: fakeLocation("/form"), fetch });
  try {
    let resolveAction: ((v: unknown) => void) | undefined;
    const formAction = () => new Promise<unknown>((r) => (resolveAction = r));
    let nav: ReturnType<typeof useNavigation> | undefined;
    let submit: ReturnType<typeof useSubmit> | undefined;
    const Probe = () => {
      nav = useNavigation();
      submit = useSubmit();
      return h("p", null, nav.state);
    };
    const screen = await render(route({ formAction, children: h(Probe, null) }));

    // A submission takes precedence over any background navigation state, reporting "submitting".
    await screen.act(() => submit!({ name: "Ada" }));
    await waitFor(() => assertEquals(nav?.state, "submitting"));
    assertEquals(nav?.formMethod, "post");

    // After the action settles the submission clears; a router refresh may leave the
    // global navigating signal "loading", so assert only that it left "submitting".
    resolveAction!({ ok: true });
    await waitFor(() => assert(nav?.state !== "submitting"));
  } finally {
    restore();
  }
});

Deno.test("useRevalidator refreshes the router and reports idle", async () => {
  const { fetch, calls } = hangingFetch();
  const restore = stub({ location: fakeLocation("/x"), fetch });
  try {
    let rev: ReturnType<typeof useRevalidator> | undefined;
    const Probe = () => {
      rev = useRevalidator();
      return h("p", null, rev.state);
    };
    const screen = await render(h(Probe, null));
    assertEquals(rev?.state, "idle");
    await screen.act(() => rev!.revalidate());
    assert(calls.length > 0, "revalidate triggers a router refresh (a navigate/fetch)");
  } finally {
    restore();
  }
});

Deno.test("useFormAction / useHref / useResolvedPath resolve paths", async () => {
  let formAction: string | undefined;
  let formActionDefault: string | undefined;
  let href: string | undefined;
  let resolved: ReturnType<typeof useResolvedPath> | undefined;
  const Probe = () => {
    formAction = useFormAction("/explicit");
    formActionDefault = useFormAction(); // defaults to the current pathname
    href = useHref("/to", { relative: "path" });
    resolved = useResolvedPath("/base?q=1#h");
    return h("p", null, "ok");
  };
  await render(h(Probe, null));
  assertEquals(formAction, "/explicit");
  assertEquals(typeof formActionDefault, "string");
  assertEquals(href, "/to");
  assertEquals(resolved, { pathname: "/base", search: "?q=1", hash: "#h" });
});

// ── Submission (useSubmit → runRouteAction, useActionData) ─────────────────────

Deno.test("useSubmit runs the route action; useActionData sees the result; toFormData coercions", async () => {
  const { fetch } = hangingFetch();
  const restore = stub({ location: fakeLocation("/save"), fetch });
  try {
    const seen: FormData[] = [];
    const formAction = (fd: FormData) => {
      seen.push(fd);
      return Promise.resolve({ saved: seen.length });
    };
    let submit: ReturnType<typeof useSubmit> | undefined;
    let action: unknown;
    const Probe = () => {
      submit = useSubmit();
      action = useActionData();
      return h("p", null, JSON.stringify(action ?? null));
    };
    const screen = await render(route({ formAction, children: h(Probe, null) }));
    assertEquals(action, undefined);

    // A plain record → FormData.
    await screen.act(() => submit!({ name: "Ada", age: "3" }));
    await waitFor(() => assertEquals((action as { saved: number })?.saved, 1));
    assertEquals(seen[0].get("name"), "Ada");

    // An existing FormData is passed through untouched.
    const fd = new FormData();
    fd.append("x", "y");
    await screen.act(() => submit!(fd));
    await waitFor(() => assertEquals((action as { saved: number })?.saved, 2));
    assertEquals(seen[1].get("x"), "y");

    // null → an empty FormData.
    await screen.act(() => submit!(null));
    await waitFor(() => assertEquals((action as { saved: number })?.saved, 3));
    assertEquals([...seen[2].keys()].length, 0);
  } finally {
    restore();
  }
});

Deno.test("useSubmit with no route action is a no-op", async () => {
  let submit: ReturnType<typeof useSubmit> | undefined;
  const Probe = () => {
    submit = useSubmit();
    return h("p", null, "ok");
  };
  const screen = await render(h(Probe, null)); // no RouteContext → route is null
  await screen.act(() => submit!({ a: "1" }));
  assert(true, "submitting without a bound action does not throw");
});

// ── useFetcher (load + submit, same-route and cross-route) ─────────────────────

Deno.test("useFetcher.load pulls loader data out of a Flight payload", async () => {
  const flight = [[{
    $: "c",
    p: { id: "routes/notes", loaderData: { notes: [1, 2, 3] }, params: {} },
    c: [],
  }]];
  const mockFetch = ((_i: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(flight), {
        headers: { "content-type": "application/json", "x-denext-flight": "1" },
      }),
    )) as typeof fetch;
  const restore = stub({ location: fakeLocation("/notes"), fetch: mockFetch });
  try {
    let fetcher: ReturnType<typeof useFetcher> | undefined;
    const Probe = () => {
      fetcher = useFetcher();
      return h("p", null, fetcher.state);
    };
    const screen = await render(route({ children: h(Probe, null) }));
    await screen.act(() => fetcher!.load("/notes"));
    await waitFor(() => assertEquals((fetcher?.data as { notes: number[] })?.notes, [1, 2, 3]));
    assertEquals(fetcher?.state, "idle");
  } finally {
    restore();
  }
});

Deno.test("useFetcher.load reads a resource route's raw JSON", async () => {
  const mockFetch = ((_i: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: 1 }), { headers: { "content-type": "application/json" } }),
    )) as typeof fetch;
  const restore = stub({ location: fakeLocation("/api"), fetch: mockFetch });
  try {
    let fetcher: ReturnType<typeof useFetcher> | undefined;
    const Probe = () => {
      fetcher = useFetcher({ key: "res" });
      return h("p", null, fetcher.state);
    };
    const screen = await render(route({ children: h(Probe, null) }));
    await screen.act(() => fetcher!.load("/api/thing"));
    await waitFor(() => assertEquals((fetcher?.data as { ok: number })?.ok, 1));
  } finally {
    restore();
  }
});

Deno.test("useFetcher.submit (same-route) runs the bound action and settles", async () => {
  const { fetch } = hangingFetch();
  const restore = stub({ location: fakeLocation("/save"), fetch });
  try {
    const formAction = (fd: FormData) => Promise.resolve({ got: fd.get("k") });
    let fetcher: ReturnType<typeof useFetcher> | undefined;
    const Probe = () => {
      fetcher = useFetcher();
      return h(fetcher.Form, { method: "post", children: h("input", { name: "k" }) });
    };
    const screen = await render(route({ formAction, children: h(Probe, null) }));
    await screen.act(() => fetcher!.submit({ k: "v" }));
    await waitFor(() => assertEquals((fetcher?.data as { got: string })?.got, "v"));
    assertEquals(fetcher?.state, "idle");
  } finally {
    restore();
  }
});

Deno.test("useFetcher.submit (cross-route action URL) posts and reads back JSON", async () => {
  const mockFetch = ((_i: unknown, init?: RequestInit) => {
    assertEquals(init?.method, "put");
    return Promise.resolve(
      new Response(JSON.stringify({ created: true }), {
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  const restore = stub({ location: fakeLocation("/x"), fetch: mockFetch });
  try {
    let fetcher: ReturnType<typeof useFetcher> | undefined;
    const Probe = () => {
      fetcher = useFetcher();
      return h("p", null, fetcher.state);
    };
    const screen = await render(route({ children: h(Probe, null) }));
    await screen.act(() => fetcher!.submit({ a: "1" }, { action: "/api/create", method: "put" }));
    await waitFor(() => assertEquals((fetcher?.data as { created: boolean })?.created, true));
  } finally {
    restore();
  }
});

Deno.test("useFetcher.submit follows a redirecting cross-route action", async () => {
  let calls = 0;
  const mockFetch = ((_input: unknown) => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(
        {
          redirected: true,
          url: "http://x/dashboard",
          headers: new Headers(),
        } as unknown as Response,
      );
    }
    return new Promise<Response>(() => {}); // the follow-up soft-nav fetch hangs
  }) as typeof fetch;
  const restore = stub({ location: fakeLocation("/login"), fetch: mockFetch });
  try {
    let fetcher: ReturnType<typeof useFetcher> | undefined;
    const Probe = () => {
      fetcher = useFetcher();
      return h("p", null, fetcher.state);
    };
    const screen = await render(route({ children: h(Probe, null) }));
    await screen.act(() => fetcher!.submit({ email: "a@b.c" }, { action: "/login" }));
    await waitFor(() => assertEquals(fetcher?.state, "idle"));
    assert(calls >= 2, "the redirect was followed by a soft navigation");
  } finally {
    restore();
  }
});

// ── Components: Link / NavLink / Form / Outlet ─────────────────────────────────

Deno.test("Link honors reloadDocument (plain <a>) and prefetch=none", async () => {
  const reload = await render(h(Link, { to: "/doc", reloadDocument: true, children: "Doc" }));
  assert(reload.html().includes('href="/doc"'));
  const soft = await render(h(Link, { href: "/soft", prefetch: "none", children: "Soft" }));
  assert(soft.html().includes("/soft"));
});

Deno.test("NavLink computes isActive and resolves function className/style/children", async () => {
  // The harness pathname is "/" at rest, so an end-mode NavLink to "/" is active.
  const active = await render(
    h(NavLink, {
      to: "/",
      end: true,
      className: (s: { isActive: boolean }) => (s.isActive ? "on" : "off"),
      style: (s: { isActive: boolean }) => ({ color: s.isActive ? "red" : "blue" }),
      children: (s: { isActive: boolean }) => h("span", null, s.isActive ? "active" : "idle"),
    } as never),
  );
  assert(active.html().includes("active"), `expected active child: ${active.html()}`);
  assert(active.html().includes("aria-current"), "an active NavLink marks aria-current");

  // A non-matching NavLink with plain string className/style resolves inactive.
  const inactive = await render(
    h(NavLink, {
      to: "/other",
      caseSensitive: true,
      className: "plain",
      style: { color: "green" },
      children: "x",
    } as never),
  );
  assert(inactive.html().includes("plain"));
});

Deno.test("Form renders a bound form and short-circuits on onSubmit-prevent / reloadDocument", async () => {
  const restore = stub({ location: fakeLocation("/f") });
  try {
    // Rendering a mutating Form computes its DOM action attribute (formActionAttr).
    let prevented = false;
    const screen = await render(
      route({
        children: h(Form, {
          method: "post",
          onSubmit: (e: Event) => {
            prevented = true;
            e.preventDefault();
          },
          children: h("button", { type: "submit" }, "Go"),
        } as never),
      }),
    );
    // A submit whose onSubmit prevents default returns before touching FormData. The event
    // is dispatched on the button and bubbles to the form's handler.
    await screen.fireEvent.submit(screen.getByRole("button"));

    // reloadDocument makes the form a native submit — the handler returns early.
    const reload = await render(
      route({
        children: h(Form, {
          method: "post",
          reloadDocument: true,
          children: h("button", { type: "submit" }, "Reload"),
        } as never),
      }),
    );
    assert(reload.html().includes("Reload"));
    assert(prevented, "onSubmit ran");
  } finally {
    restore();
  }
});

Deno.test("Outlet / OutletProvider / useOutletContext thread the layout subtree + context", async () => {
  let ctx: unknown;
  const Child = () => {
    ctx = useOutletContext();
    return h("p", null, "child");
  };
  const screen = await render(
    h(OutletProvider, {
      outlet: h(Child, null),
      children: h(Outlet, { context: { theme: "dark" } }),
    } as never),
  );
  assert(screen.html().includes("child"));
  assertEquals(ctx, { theme: "dark" });
});

// ── Deferred data: <Await> with real promises + useAsyncValue/useAsyncError ────

Deno.test("Await resolves a real promise and exposes it via useAsyncValue", async () => {
  const Show = () => {
    const v = useAsyncValue<{ n: number }>();
    return h("p", null, `n=${v.n}`);
  };
  const screen = await render(
    h(Suspense, {
      fallback: h("span", null, "loading"),
      children: h(Await, { resolve: Promise.resolve({ n: 7 }), children: h(Show, null) } as never),
    }),
  );
  await waitFor(() => assert(screen.html().includes("n=7"), `got: ${screen.html()}`));
});

Deno.test("Await renders a resolved promise through a children render-prop", async () => {
  const screen = await render(
    h(Suspense, {
      fallback: h("span", null, "loading"),
      children: h(Await, {
        resolve: Promise.resolve("hello"),
        children: (v: string) => h("span", null, v.toUpperCase()),
      } as never),
    }),
  );
  await waitFor(() => assert(screen.html().includes("HELLO"), `got: ${screen.html()}`));
});

Deno.test("Await renders errorElement (useAsyncError) when the client promise rejects", async () => {
  const ErrView = () => {
    const err = useAsyncError();
    return h("p", null, err instanceof Error ? `err:${err.message}` : "no-error");
  };
  const rejected = Promise.reject(new Error("late boom"));
  rejected.catch(() => {}); // mark handled (Await reads the rejection through readPromise)
  const screen = await render(
    h(Suspense, {
      fallback: h("span", null, "loading"),
      children: h(Await, {
        resolve: rejected,
        errorElement: h(ErrView, null),
        children: h("span", null, "unused"),
      } as never),
    }),
  );
  await waitFor(() => assert(screen.html().includes("err:late boom"), `got: ${screen.html()}`));
});

// ── useBlocker: proceed() lets the held navigation through ──────────────────────

Deno.test("useBlocker blocks a soft nav then proceed() lets it through", async () => {
  // A fetch that rejects lets the proceed()'d navigation settle (hard-nav fallback) so the
  // blocker returns to "unblocked" instead of hanging in "proceeding".
  const rejectingFetch = (() => Promise.reject(new Error("no network"))) as typeof fetch;
  const restore = stub({ location: fakeLocation("/a"), fetch: rejectingFetch });
  try {
    let latest: Blocker | undefined;
    const Guard = () => {
      latest = useBlocker(({ nextLocation }) => nextLocation.pathname === "/b");
      return h("p", null, latest.state);
    };
    await render(h(Guard, null));
    void navigate("/b");
    await waitFor(() => assertEquals(latest?.state, "blocked"));
    assertEquals(latest?.location?.pathname, "/b");

    latest!.proceed!();
    await waitFor(() => assert(latest?.state !== "blocked"), { timeout: 2000 });
  } finally {
    restore();
  }
});

Deno.test("useBlocker predicate that never matches lets navigation pass", async () => {
  const { fetch, calls } = hangingFetch();
  const restore = stub({ location: fakeLocation("/a"), fetch });
  try {
    let latest: Blocker | undefined;
    const Guard = () => {
      latest = useBlocker(({ nextLocation }) => nextLocation.pathname === "/never");
      return h("p", null, latest.state);
    };
    await render(h(Guard, null));
    void navigate("/b");
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(latest?.state, "unblocked");
    assert(calls.length > 0, "the non-matching nav proceeded to fetch");
  } finally {
    restore();
  }
});
