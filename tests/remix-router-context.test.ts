// React Router 7's typed context and route middleware on the `denext/remix` runtime (roadmap
// P3): `createContext` / `RouterContextProvider`, the per-request `context` a load-context
// provider computes (always a provider, a plain object's properties carried onto it), and the
// middleware chain run ahead of loaders/actions — nested around the handler on a resource route,
// before the loader (once per route per request) on a page.

import { assert, assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import {
  createContext,
  RouterContextProvider,
  unstable_createContext,
  unstable_RouterContextProvider,
} from "../src/compat/remix/router-context.ts";
import {
  clearLoadContext,
  defineLoadContext,
  loadContext,
} from "../src/compat/remix/load-context.ts";
import { composeMiddleware, type MiddlewareFunction } from "../src/compat/remix/middleware.ts";
import {
  bindAction,
  redirect,
  type RouteMiddleware,
  runActionResponse,
  runLoaderOnce,
  runLoaderResponse,
} from "../src/compat/remix/server.ts";
import { RedirectError } from "../src/runtime/error-boundary.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

const inRequest = <T>(fn: () => Promise<T>, url = "http://localhost/x") => {
  const ctx = createRequestContext(new Request(url));
  return { ctx, result: runWithContext(ctx, fn) };
};

Deno.test("router context: get / set / default / missing, Map init, the unstable_ names", () => {
  const count = createContext(0);
  const name = createContext<string>();
  const provider = new RouterContextProvider(new Map([[name, "init"]]));
  assertEquals(provider.get(count), 0, "the default before a value is set");
  assertEquals(provider.get(name), "init", "a Map passed to the constructor");
  provider.set(count, 2);
  assertEquals(provider.get(count), 2);
  assertThrows(() => new RouterContextProvider().get(name), Error, "No value found for context");
  assertEquals(unstable_createContext, createContext);
  assertEquals(unstable_RouterContextProvider, RouterContextProvider);
  assertEquals(Object.keys(provider), [], "values are not enumerable properties");
});

Deno.test("load context: no provider → an empty RouterContextProvider, shared by the request", async () => {
  clearLoadContext();
  const key = createContext("none");
  const { result } = inRequest(async () => {
    const a = await loadContext(new Request("http://localhost/x"), {});
    a.set(key, "set by a middleware");
    const b = await loadContext(new Request("http://localhost/x"), {});
    return { a, b };
  });
  const { a, b } = await result;
  assertInstanceOf(a, RouterContextProvider);
  assert(a === b, "memoized per request");
  assertEquals(b.get(key), "set by a middleware");
});

Deno.test("load context: a plain object's properties ride on a provider (getters unevaluated)", async () => {
  let evaluated = 0;
  defineLoadContext(() => ({
    db: "the-db",
    get lazy() {
      evaluated++;
      return "lazy";
    },
  }));
  try {
    const context = await loadContext(new Request("http://localhost/"), {});
    assertInstanceOf(context, RouterContextProvider);
    assertEquals(context.db, "the-db");
    assertEquals(evaluated, 0, "a getter is copied, not read");
    assertEquals(context.lazy, "lazy");
    const key = createContext<number>();
    context.set(key, 1);
    assertEquals(context.get(key), 1, "typed keys work beside the Remix properties");
  } finally {
    clearLoadContext();
  }
});

Deno.test("load context: a returned RouterContextProvider is used as is; a class instance too", async () => {
  const provided = new RouterContextProvider();
  defineLoadContext(() => provided);
  try {
    assert((await loadContext(new Request("http://localhost/"), {})) === provided);
    class Env {
      binding() {
        return "kv";
      }
    }
    const env = new Env();
    defineLoadContext(() => env as unknown as Record<string, unknown>);
    const context = await loadContext(new Request("http://localhost/"), {});
    assert((context as unknown) === env, "copying would drop the prototype's methods");
  } finally {
    clearLoadContext();
  }
});

Deno.test("middleware: composed outermost first; next() runs the rest; a Response answers", async () => {
  const order: string[] = [];
  const args = { request: new Request("http://localhost/"), params: {}, context: {} as never };
  const fns: MiddlewareFunction[] = [
    async (_args, next) => {
      order.push("a:in");
      const res = await next();
      order.push("a:out");
      res.headers.set("x-a", "1");
      return res;
    },
    () => {
      order.push("b"); // returns nothing and never calls next(): next() is called for it
    },
  ];
  const res = await composeMiddleware(fns, args, () => {
    order.push("handler");
    return Promise.resolve(new Response("ok"));
  });
  assertEquals(order, ["a:in", "b", "handler", "a:out"]);
  assertEquals(res.headers.get("x-a"), "1");
  assertEquals(await res.text(), "ok");

  const early = await composeMiddleware(
    [() => new Response("early", { status: 401 })],
    args,
    () => Promise.reject(new Error("the handler must not run")),
  );
  assertEquals(early.status, 401);

  await assertRejects(
    () =>
      composeMiddleware(
        [async (_a, next) => {
          await next();
          await next();
        }],
        args,
        () => Promise.resolve(new Response()),
      ),
    Error,
    "only call `next()` once",
  );
});

Deno.test("middleware: a resource route's chain wraps the handler and sees the same context", async () => {
  const user = createContext("nobody");
  const chain: RouteMiddleware[] = [
    {
      id: "root",
      middleware: [async ({ context }, next) => {
        context.set(user, "ada");
        const res = await next();
        res.headers.set("x-root", "1");
        return res;
      }],
    },
    { id: "routes/none" },
  ];
  const res = await runLoaderResponse(
    ({ context }) => ({ user: context.get(user) }),
    new Request("http://localhost/api"),
    chain,
  );
  assertEquals(await res.json(), { user: "ada" });
  assertEquals(res.headers.get("x-root"), "1");

  const denied = await runActionResponse(
    () => ({ ran: true }),
    new Request("http://localhost/api", { method: "POST" }),
    {},
    [{ id: "root", middleware: [() => new Response("no", { status: 403 })] }],
  );
  assertEquals(denied.status, 403, "returning a Response short-circuits the action");
});

Deno.test("middleware: on a page each route's chain runs once, before the loaders", async () => {
  let rootRuns = 0;
  const seen = createContext<string[]>([]);
  const root: RouteMiddleware = {
    id: "root",
    middleware: [async ({ context }, next) => {
      rootRuns++;
      context.set(seen, [...context.get(seen), "root"]);
      const res = await next();
      res.headers.set("set-cookie", "mw=1");
      res.headers.set("x-mw", "page");
      return res;
    }],
  };
  const page: RouteMiddleware = {
    id: "routes/page",
    middleware: [({ context }) => void context.set(seen, [...context.get(seen), "page"])],
  };
  const { ctx, result } = inRequest(async () => {
    const parent = await runLoaderOnce("root", ({ context }) => context.get(seen), {}, [root]);
    const child = await runLoaderOnce(
      "routes/page",
      ({ context }) => context.get(seen),
      {},
      [root, page],
    );
    return { parent, child };
  });
  const { parent, child } = await result;
  assertEquals(parent, ["root"]);
  assertEquals(child, ["root", "page"]);
  assertEquals(rootRuns, 1, "the root's middleware ran once for both loaders");
  assertEquals(ctx.outgoingHeaders.get("x-mw"), "page", "next()'s headers reach the page");
  assertEquals(ctx.outgoingHeaders.get("set-cookie"), "mw=1");
});

Deno.test("middleware: a thrown redirect stops the loader and the action", async () => {
  let loaded = false;
  const guard: RouteMiddleware[] = [{
    id: "root",
    middleware: [() => {
      throw redirect("/login");
    }],
  }];
  const { result } = inRequest(() =>
    runLoaderOnce(
      "routes/x",
      () => {
        loaded = true;
        return null;
      },
      {},
      guard,
    )
  );
  const err = await assertRejects(() => result);
  assertInstanceOf(err, RedirectError);
  assertEquals((err as RedirectError).url, "/login");
  assertEquals(loaded, false);

  let acted = false;
  const action = bindAction(
    () => {
      acted = true;
      return null;
    },
    "routes/x",
    {},
    guard,
  )!;
  const posted = inRequest(() => action(new FormData()));
  assertInstanceOf(await assertRejects(() => posted.result), RedirectError);
  assertEquals(acted, false);
});
