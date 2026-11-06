// next-intl's provider is a Client Component in next-intl, so a root layout (a Server Component)
// rendering `<NextIntlClientProvider>` still reaches the `"use client"` islands below it. denext's
// provider provides the context on the server (Server Components below it read it during the
// Flight pass) and renders the framework client reference `denext#NextIntlClientProvider`, which
// the browser resolves to the same provider: an island calling `useTranslations()` translates
// after hydration, on the page root and as a carved `client:*` island alike.

// deno-lint-ignore-file no-explicit-any -- tests poke Flight node internals.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToHtmlFlight } from "../src/jsx/render-to-html-flight.ts";
import { renderToFlight } from "../src/jsx/render-to-flight.ts";
import { tagClientExports } from "../src/runtime/client-reference.ts";
import { parseFlight } from "../src/client/flight-client.ts";
import { flushSync, hydrateRoot, setDocument } from "../src/client/reconciler.ts";
import { useEffect, useState } from "../src/runtime/hooks.ts";
import { appUsesNextIntl, generateFlightEntry } from "../src/build/bundle.ts";
import { join } from "@std/path";
import type { BoundaryManifest } from "../src/build/module-graph.ts";
import {
  NextIntlClientBoundary,
  NextIntlClientProvider,
  useTranslations,
} from "../src/compat/next-intl/index.ts";
import type { NestedMessages } from "../src/compat/next-intl/context.ts";
import { makeDom } from "./helpers/dom.ts";
import type { Component, VNode } from "../src/jsx/types.ts";

const messages: NestedMessages = {
  Home: { title: "Hello", greeting: "Welcome, {name}" },
  Island: { first: "Server paint", hydrated: "Translated in the browser" },
};
const REF = "denext#NextIntlClientProvider";

/** A Server Component under the provider. */
function ServerTitle(): VNode {
  const t = useTranslations("Home");
  return h("h1", null, t("title"));
}

/** A `"use client"` island under the provider: it translates on the server and after hydration. */
function Greeting(): VNode {
  const t = useTranslations("Island");
  const [label, setLabel] = useState(t("first"));
  useEffect(() => setLabel(t("hydrated")), [t]);
  return h("p", { id: "greeting" }, label);
}
const islandMod = { Greeting };
tagClientExports(islandMod as Record<string, unknown>, "c_intl");

/** The registry the generated Flight entry builds (the island + the provider boundary). */
const registry = new Map<string, Component>([
  ["c_intl#Greeting", Greeting as Component],
  [REF, NextIntlClientBoundary as unknown as Component],
]);

/** The root layout: a Server Component rendering the provider around the page. */
function layout(children: unknown): VNode {
  return h("main", null, h(NextIntlClientProvider, { locale: "en", messages, children } as never));
}

/** Let effects run and commit. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
}

/** Every client reference node in a Flight tree. */
function refsIn(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) { for (const n of node) refsIn(n, out); }
  else if (node && typeof node === "object") {
    if (node.$ === "c") out.push(node);
    for (const c of node.c ?? []) refsIn(c, out);
  }
  return out;
}

Deno.test("next-intl: a Server Component under the provider reads its context in the Flight pass", async () => {
  const tree = layout(h(ServerTitle, null));
  const flight = await renderToFlight(tree);
  const [boundary] = refsIn(flight);
  assertEquals(boundary.i, REF, "the provider crosses as its client boundary");
  assertEquals(boundary.p.locale, "en");
  assertEquals(boundary.p.messages.Home.title, "Hello");
  // The server child is expanded (with the provider's context) into the boundary's holes.
  assertStringIncludes(JSON.stringify(boundary.c), '"Hello"');
  const { html } = await renderToHtmlFlight(tree);
  assertStringIncludes(html, "<h1>Hello</h1>");
});

Deno.test("next-intl: a 'use client' island under the provider translates after hydration", async () => {
  const { html, flight } = await renderToHtmlFlight(layout(h(Greeting, null)));
  assertStringIncludes(html, "Server paint");
  const { doc, container } = makeDom();
  setDocument(doc as any);
  container.innerHTML = html;
  hydrateRoot(container as any, parseFlight(flight as any, registry) as VNode);
  await settle();
  assertStringIncludes(container.innerHTML, "Translated in the browser");
});

Deno.test("next-intl: a carved client:* island under the provider carries the provider", async () => {
  const tree = layout(h("section", null, h(Greeting, { "client:visible": true } as never)));
  const { html, islands } = await renderToHtmlFlight(tree);
  assertEquals(islands.length, 1);
  const island = islands[0];
  // The island hydrates on a root of its own: its Flight is wrapped in the provider boundary.
  const outer = island.flight as any;
  assertEquals(outer.i, REF);
  assertEquals(outer.p.messages.Island.hydrated, "Translated in the browser");
  assertEquals(outer.c[0].i, "c_intl#Greeting");

  // Hydrate it the way the resumability runtime does (lazy-boot.ts's hydrateIsland).
  const { doc, container } = makeDom();
  setDocument(doc as any);
  container.innerHTML = html;
  const find = (n: any): any =>
    n.getAttribute?.("data-dnx-id") === island.id
      ? n
      : (n.childNodes ?? []).map(find).find(Boolean);
  const wrapper = find(container);
  assert(wrapper, "the island's wrapper is in the markup");
  hydrateRoot(wrapper, parseFlight(island.flight, registry) as VNode);
  await settle();
  assertStringIncludes(wrapper.innerHTML, "Translated in the browser");
});

Deno.test("next-intl: function props are dropped from the client boundary with a dev warning", async () => {
  const g = globalThis as { __denextDev?: boolean };
  const prev = g.__denextDev;
  const warn = console.warn;
  const warnings: string[] = [];
  g.__denextDev = true;
  console.warn = (msg: string) => void warnings.push(String(msg));
  try {
    const tree = h(
      NextIntlClientProvider,
      { locale: "en", messages, onError: () => {}, children: h(ServerTitle, null) } as never,
    );
    const { flight } = await renderToHtmlFlight(tree);
    const [boundary] = refsIn(flight);
    assertEquals(boundary.i, REF);
    assert(!("onError" in boundary.p), "the function never reaches the payload");
    assert(
      warnings.some((w) => w.includes("<NextIntlClientProvider>") && w.includes('"onError"')),
      warnings.join("\n"),
    );
  } finally {
    console.warn = warn;
    if (prev === undefined) delete g.__denextDev;
    else g.__denextDev = prev;
  }
});

Deno.test("next-intl: the Flight entry registers the provider boundary only when the app uses it", () => {
  const boundary: BoundaryManifest = { client: new Map(), server: new Map() };
  const args = [false, false, true, null, "lazy", false, false, {}, true, true] as const;
  const used = generateFlightEntry(boundary, ...args, true);
  assertStringIncludes(used, 'import { NextIntlClientBoundary } from "denext/next-intl"');
  assertStringIncludes(used, `registry.set("${REF}", NextIntlClientBoundary)`);
  const unused = generateFlightEntry(boundary, ...args, false);
  assert(!unused.includes("denext/next-intl"), "an app without the provider bundles none of it");
});

Deno.test("next-intl: the build scan finds a provider in the app's sources", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "app"));
    await Deno.writeTextFile(join(dir, "app", "page.tsx"), "export default () => <p />;\n");
    assertEquals(await appUsesNextIntl(dir), false);
    await Deno.writeTextFile(
      join(dir, "app", "layout.tsx"),
      'import { NextIntlClientProvider } from "next-intl";\n',
    );
    assertEquals(await appUsesNextIntl(dir), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
