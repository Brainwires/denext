// React 19's `captureOwnerStack()` (development, client render) and React 19.2's
// `cacheSignal()` (server render) on the `react` compat surface.

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import type { VNode } from "../src/jsx/types.ts";
import { cacheSignal, captureOwnerStack } from "../src/compat/react.ts";
import { memo } from "../mod.ts";
import { render } from "../src/testing/mod.ts";
import {
  createRequestContext,
  runDeferred,
  runWithContext,
} from "../src/server/request-context.ts";
import { cacheScopeStorage } from "../src/server/cache-scope.ts";
import { createApp } from "../src/server/app.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { createResource, Suspense } from "../src/runtime/suspense.ts";

type DevGlobal = { __denextDev?: boolean };

/** Run `fn` with `__denextDev` set as given, restoring it afterwards. */
async function withDev<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as DevGlobal;
  const prev = g.__denextDev;
  if (on) g.__denextDev = true;
  else delete g.__denextDev;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete g.__denextDev;
    else g.__denextDev = prev;
  }
}

/** App > Parent > Memo(Middle) > Child, Child recording captureOwnerStack() as it renders. */
async function renderOwnerTree(): Promise<Array<string | null>> {
  const seen: Array<string | null> = [];
  function Child(): VNode {
    seen.push(captureOwnerStack());
    return h("span", null, "child");
  }
  function MiddleImpl(): VNode {
    return h(Child, null);
  }
  const Middle = memo(MiddleImpl);
  function Parent(): VNode {
    return h("div", null, h(Middle, null));
  }
  function App(): VNode {
    return h("main", null, h(Parent, null));
  }
  const screen = await render(h(App, null));
  screen.unmount();
  return seen;
}

Deno.test("captureOwnerStack: React 19's owner stack while a component renders (dev)", async () => {
  await withDev(true, async () => {
    const seen = await renderOwnerTree();
    assert(seen.length > 0, "Child rendered");
    // One `\n    at Name` line per component above the caller, nearest first; the caller itself
    // is not in it. Host elements are not owners.
    assertEquals(seen[0], "\n    at Memo(MiddleImpl)\n    at Parent\n    at App");
  });
});

Deno.test("captureOwnerStack: null outside a render, and in production", async () => {
  await withDev(true, () => {
    assertStrictEquals(captureOwnerStack(), null);
    return Promise.resolve();
  });
  await withDev(false, async () => {
    const seen = await renderOwnerTree();
    assert(seen.length > 0);
    for (const s of seen) assertStrictEquals(s, null);
  });
});

Deno.test("cacheSignal: null outside a server render", () => {
  assertStrictEquals(cacheSignal(), null);
});

Deno.test("cacheSignal: one signal per render, aborted when the render ends", async () => {
  const ctx = createRequestContext(new Request("http://localhost/"));
  const first = runWithContext(ctx, () => cacheSignal());
  assert(first instanceof AbortSignal);
  assertStrictEquals(runWithContext(ctx, () => cacheSignal()), first, "same scope, same signal");
  assertEquals(first.aborted, false);
  await runDeferred(ctx);
  assertEquals(first.aborted, true);
  assert(first.reason instanceof Error);
  assert(String(first.reason.message).includes("render completed successfully"));
  // A call after the scope ended gets the ended scope's (aborted) signal.
  assertEquals(runWithContext(ctx, () => cacheSignal())?.aborted, true);
  // Another request is another scope.
  const other = createRequestContext(new Request("http://localhost/"));
  assertEquals(runWithContext(other, () => cacheSignal())?.aborted, false);
});

Deno.test("cacheSignal: aborts with the request when the client goes away", () => {
  const request = new AbortController();
  const ctx = createRequestContext(new Request("http://localhost/"), request.signal);
  const signal = runWithContext(ctx, () => cacheSignal())!;
  const reason = new Error("client disconnected");
  request.abort(reason);
  assertEquals(signal.aborted, true);
  assertStrictEquals(signal.reason, reason);
  // A request already aborted hands out an aborted signal.
  const gone = createRequestContext(new Request("http://localhost/"), request.signal);
  assertEquals(runWithContext(gone, () => cacheSignal())?.aborted, true);
});

Deno.test('cacheSignal: null inside a "use cache" scope (a shared fill)', () => {
  const ctx = createRequestContext(new Request("http://localhost/"));
  const inScope = runWithContext(
    ctx,
    () => cacheScopeStorage.run({} as never, () => cacheSignal()),
  );
  assertStrictEquals(inScope, null);
});

function manifest(): RouteManifest {
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
    pages: [{ ...base, pattern: parsePattern("/"), routePath: "/", filePath: "home.tsx" }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

Deno.test("cacheSignal: live through a streamed page's Suspense hole, aborted after its end", async () => {
  const signals: AbortSignal[] = [];
  const abortedWhileRendering: boolean[] = [];
  const record = () => {
    const s = cacheSignal()!;
    signals.push(s);
    abortedWhileRendering.push(s.aborted);
  };
  const read = createResource(() => new Promise<string>((r) => setTimeout(() => r("late"), 5)));
  const Slow = (): VNode => {
    const text = read();
    record();
    return h("strong", null, text);
  };
  const Page = (): VNode => {
    record();
    return h("div", null, h(Suspense, { fallback: h("p", null, "…"), children: h(Slow, null) }));
  };
  const app = createApp({
    getManifest: manifest,
    load: (fp: string) => Promise.resolve(fp === "home.tsx" ? { default: Page } : undefined),
  });
  const res = await app(new Request("http://localhost/"));
  const html = await res.text();
  assert(html.includes("late"), "the hole streamed");
  assert(signals.length >= 2, "the shell and the hole both rendered");
  assertEquals(abortedWhileRendering.every((a) => !a), true, "never aborted mid-render");
  assertStrictEquals(signals.at(-1), signals[0], "one scope for the whole render");
  assertEquals(signals[0].aborted, true, "aborted once the body ended");
});
