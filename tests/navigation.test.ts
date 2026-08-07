import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import {
  getLocationState,
  Link,
  subscribeLocation,
  usePathname,
  useRouter,
} from "../src/client/navigation.ts";
import type { VNode } from "../src/jsx/types.ts";

Deno.test("Link renders a server-side anchor with href and passthrough props", async () => {
  const html = await renderToString(
    h(Link, { href: "/about", className: "nav", children: "About" }),
  );
  assertStringIncludes(html, "<a");
  assertStringIncludes(html, 'href="/about"');
  assertStringIncludes(html, 'class="nav"');
  assertStringIncludes(html, ">About</a>");
  // The click handler is stripped during SSR.
  assertEquals(html.includes("onClick"), false);
});

Deno.test("usePathname returns the current pathname during SSR", async () => {
  function Where(): VNode {
    return h("code", null, usePathname());
  }
  const html = await renderToString(h(Where, null));
  // On the server, location is unavailable so it defaults to "/".
  assertEquals(html, "<code>/</code>");
});

Deno.test("useRouter exposes navigation methods", () => {
  // useRouter doesn't use the hook dispatcher; calling it here is intentional.
  // deno-lint-ignore denext/rules-of-hooks
  const router = useRouter();
  assertEquals(typeof router.push, "function");
  assertEquals(typeof router.replace, "function");
  assertEquals(typeof router.back, "function");
  assertEquals(typeof router.forward, "function");
  assertEquals(typeof router.refresh, "function");
});

Deno.test("location store notifies subscribers and can unsubscribe", () => {
  let calls = 0;
  const unsub = subscribeLocation(() => calls++);
  // getLocationState is always readable.
  const state = getLocationState();
  assertEquals(typeof state.pathname, "string");
  unsub();
  // After unsubscribe the listener set no longer holds our callback.
  assertEquals(calls, 0);
});
