// `denext/remix`'s route-module client data APIs (React Router v7 framework mode / Remix ≥ 2.4):
// `useClientRouteData` runs a route's `clientLoader` — on hydration only when it hydrates
// (`clientLoader.hydrate`, or no server loader), with `HydrateFallback` meanwhile; on every
// revalidation; and on a route a navigation mounts — and `useClientRouteAction` routes a
// submission through `clientAction`, whose `serverAction()` runs the server action. Driven
// through the client render harness (effects run), as the generated boundary uses them.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { h } from "denext/jsx-runtime";
import { useEffect } from "denext";
import { render, waitFor } from "denext/testing";
import {
  type ClientActionFunction,
  type ClientLoaderFunction,
  type ClientRouteDataOptions,
  resetClientRouteNavigation,
  useClientRouteAction,
  useClientRouteData,
} from "../src/compat/remix/client-data.ts";
import { data } from "../src/compat/remix/responses.ts";
import { navigate } from "../src/client/navigation.ts";

/** A probe rendering what the generated boundary would: the fallback marker or the data. */
function probe(opts: ClientRouteDataOptions) {
  return function Probe() {
    const client = useClientRouteData(opts);
    return h("p", null, client.fallback ? "fallback" : JSON.stringify(client.data ?? null));
  };
}

/** A clientLoader recording its calls; `hydrate` marks it as a hydrating loader. */
function recordingLoader(
  result: (serverData: unknown) => unknown,
  hydrate?: boolean,
): ClientLoaderFunction & { calls: number } {
  const fn = Object.assign(
    async (args: Parameters<ClientLoaderFunction>[0]) => {
      fn.calls++;
      return result(await args.serverLoader().catch((e: Error) => e.message));
    },
    { calls: 0 },
  ) as ClientLoaderFunction & { calls: number };
  if (hydrate) fn.hydrate = true;
  return fn;
}

Deno.test("clientLoader.hydrate: the HydrateFallback renders, then the client data (serverLoader included)", async () => {
  resetClientRouteNavigation();
  const gate = Promise.withResolvers<void>();
  const clientLoader = recordingLoader(
    (server) => ({ via: "client", server }),
    true,
  );
  const gated: ClientLoaderFunction = Object.assign(
    async (args: Parameters<ClientLoaderFunction>[0]) => {
      await gate.promise;
      return await clientLoader(args);
    },
    { hydrate: true },
  );
  const Probe = probe({
    id: "routes/a",
    loaderData: { n: 1 },
    params: {},
    clientLoader: gated,
    hasServerLoader: true,
    hasHydrateFallback: true,
  });
  const screen = await render(h(Probe, null));
  assert(
    screen.html().includes("fallback"),
    "the HydrateFallback renders first",
  );
  gate.resolve();
  await waitFor(() => assert(screen.html().includes('"via":"client"')));
  assert(
    screen.html().includes('"server":{"n":1}'),
    "serverLoader() resolves the server data",
  );
  assertEquals(clientLoader.calls, 1);
});

Deno.test("clientLoader without hydrate: the first load keeps the server data; a revalidation runs it", async () => {
  resetClientRouteNavigation();
  const clientLoader = recordingLoader((server) => ({ wrapped: server }));
  // Server data keeps its identity across the boundary's own re-renders (it is a prop).
  const served = new Map([[1, { n: 1 }], [2, { n: 2 }]]);
  const opts = (n: number): ClientRouteDataOptions => ({
    id: "routes/b",
    loaderData: served.get(n),
    params: { id: "1" },
    clientLoader,
    hasServerLoader: true,
    hasHydrateFallback: true,
  });
  // Effects run in declaration order, so once this one has run, the hook's load effect has too
  // (and a clientLoader it started was called synchronously, inside the effect).
  let effectsRan = 0;
  const Probe = (props: { n: number }) => {
    const client = useClientRouteData(opts(props.n));
    useEffect(() => void effectsRan++);
    return h("p", null, JSON.stringify(client.data ?? null));
  };
  const screen = await render(h(Probe, { n: 1 }));
  assert(
    screen.html().includes('{"n":1}'),
    "the server data renders on the first load",
  );
  await waitFor(() => assert(effectsRan > 0, "the mount's effects ran"));
  assertEquals(
    clientLoader.calls,
    0,
    "no client load on the document's first load",
  );
  // New server data (a revalidation after an action / a param change) runs the loader.
  await screen.rerender(h(Probe, { n: 2 }));
  await waitFor(() => assert(screen.html().includes('{"wrapped":{"n":2}}')));
  assertEquals(clientLoader.calls, 1);
});

Deno.test("a route a navigation mounts runs its clientLoader even without hydrate", async () => {
  resetClientRouteNavigation();
  const g = globalThis as { location?: unknown; fetch?: typeof fetch };
  const origLocation = g.location;
  const origFetch = g.fetch;
  g.location = {
    href: "http://x/a",
    origin: "http://x",
    pathname: "/a",
    search: "",
  };
  // A soft navigation that never settles: starting it is what marks later mounts.
  g.fetch = () => new Promise<Response>(() => {});
  try {
    void navigate("/b");
    const clientLoader = recordingLoader(() => ({ via: "navigation" }));
    const screen = await render(
      h(
        probe({
          id: "routes/c",
          loaderData: { n: 1 },
          params: {},
          clientLoader,
          hasServerLoader: true,
          hasHydrateFallback: false,
        }),
        null,
      ),
    );
    await waitFor(() => assert(screen.html().includes('"via":"navigation"')));
  } finally {
    if (origLocation === undefined) delete g.location;
    else g.location = origLocation;
    g.fetch = origFetch;
    resetClientRouteNavigation();
  }
});

Deno.test("no server loader: the clientLoader hydrates, serverLoader() rejects, data() unwraps", async () => {
  resetClientRouteNavigation();
  const clientLoader = recordingLoader((server) => data({ server }, { status: 201 }));
  const screen = await render(
    h(
      probe({
        id: "routes/d",
        loaderData: undefined,
        params: {},
        clientLoader,
        hasServerLoader: false,
        hasHydrateFallback: false,
      }),
      null,
    ),
  );
  await waitFor(() => assert(screen.html().includes("server loader")));
  assert(
    screen.html().includes(
      'does not have a server loader (routeId: \\"routes/d\\")',
    ),
    screen.html(),
  );
});

Deno.test("SPA mode without a clientLoader: the fallback renders, then the server data", async () => {
  resetClientRouteNavigation();
  const screen = await render(
    h(
      probe({
        id: "routes/e",
        loaderData: { n: 5 },
        params: {},
        hasServerLoader: true,
        hasHydrateFallback: true,
        spa: true,
      }),
      null,
    ),
  );
  await waitFor(() => assert(screen.html().includes('{"n":5}')));
});

Deno.test("clientAction: a submission runs it, and serverAction() runs the server action", async () => {
  const seen: {
    method?: string;
    params?: Record<string, string>;
    field?: string;
  } = {};
  const clientAction: ClientActionFunction = async (
    { request, params, serverAction },
  ) => {
    seen.method = request.method;
    seen.params = params;
    seen.field = String((await request.formData()).get("name"));
    return { client: true, server: await serverAction() };
  };
  let submit: ((fd: FormData) => Promise<unknown>) | undefined;
  const Probe = () => {
    submit = useClientRouteAction(
      "routes/f",
      (fd) => Promise.resolve({ saved: fd.get("name") }),
      { id: "7" },
      clientAction,
    );
    return h("p", null, "form");
  };
  await render(h(Probe, null));
  const fd = new FormData();
  fd.set("name", "Deno");
  assertEquals(await submit!(fd), { client: true, server: { saved: "Deno" } });
  assertEquals(seen, { method: "POST", params: { id: "7" }, field: "Deno" });

  let noServer: ((fd: FormData) => Promise<unknown>) | undefined;
  const Bare = () => {
    noServer = useClientRouteAction(
      "routes/g",
      undefined,
      {},
      ({ serverAction }) => serverAction(),
    );
    return h("p", null, "bare");
  };
  await render(h(Bare, null));
  await assertRejects(
    () => noServer!(new FormData()),
    Error,
    "does not have a server action",
  );
});
