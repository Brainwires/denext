import { assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { createApp } from "../src/server/app.ts";
import { type I18nConfig, resolveMessages } from "../src/server/i18n.ts";
import { interpolate, makeTranslate } from "../src/runtime/i18n-messages.ts";
import { useTranslations } from "../src/client/navigation.ts";
import { createRoot, setDocument } from "../src/client/reconciler.ts";
import type { RouteManifest } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";
import type { PageProps } from "../src/server/types.ts";
import type { VNode } from "../src/jsx/types.ts";
import { type FakeDocument, type FakeElement, makeDom } from "./helpers/dom.ts";

const MESSAGES = {
  en: { greeting: "Hello, {name}!" },
  fr: { greeting: "Bonjour, {name} !" },
};
const I18N: I18nConfig = { locales: ["en", "fr"], defaultLocale: "en", messages: MESSAGES };

// ---- Unit ------------------------------------------------------------------

Deno.test("interpolate substitutes {vars} and leaves unknowns intact", () => {
  assertEquals(interpolate("Hi {name}", { name: "Ada" }), "Hi Ada");
  assertEquals(interpolate("n={n}", { n: 3 }), "n=3");
  assertEquals(interpolate("Hi {name}"), "Hi {name}"); // no vars -> untouched
  assertEquals(interpolate("{a} {b}", { a: "x" }), "x {b}"); // missing var kept
});

Deno.test("resolveMessages resolves by locale with default fallback", () => {
  assertEquals(resolveMessages(I18N, "fr"), MESSAGES.fr);
  assertEquals(resolveMessages(I18N, "en"), MESSAGES.en);
  // Unknown locale falls back to the default locale's catalog.
  assertEquals(resolveMessages(I18N, "de"), MESSAGES.en);
  // No config -> empty.
  assertEquals(resolveMessages(undefined, "en"), {});
  assertEquals(resolveMessages({ locales: ["en"], defaultLocale: "en" }, "en"), {});
});

Deno.test("makeTranslate looks up + interpolates, missing key returns key", () => {
  const t = makeTranslate(MESSAGES.fr);
  assertEquals(t("greeting", { name: "Ada" }), "Bonjour, Ada !");
  assertEquals(t("missing"), "missing");
});

// ---- SSR through createApp -------------------------------------------------

function manifest(): RouteManifest {
  return {
    pages: [{
      kind: "page",
      pattern: parsePattern("greet"),
      routePath: "/greet",
      filePath: "greet.tsx",
      layoutChain: [],
      loading: null,
      error: null,
      notFound: null,
      forbidden: null,
      unauthorized: null,
      templateChain: [],
    }],
    api: [],
    rootLayout: null,
    rootNotFound: null,
    rootGlobalError: null,
  };
}

function Greet(p: PageProps): VNode {
  const t = useTranslations();
  return h("h1", null, t("greeting", { name: String(p.params.locale) }));
}

const modules: Record<string, unknown> = {
  "greet.tsx": { default: Greet },
};

function app(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    getManifest: manifest,
    load: (fp: string) => Promise.resolve(modules[fp]),
    i18n: I18N,
    ...over,
  });
}

Deno.test("useTranslations renders locale-correct strings server-side", async () => {
  const en = await app()(new Request("http://localhost/greet"));
  assertStringIncludes(await en.text(), "<h1>Hello, en!</h1>");

  const fr = await app()(new Request("http://localhost/fr/greet"));
  assertStringIncludes(await fr.text(), "<h1>Bonjour, fr !</h1>");
});

Deno.test("the active catalog is embedded in the hydration payload", async () => {
  const res = await app({ clientEntryFor: () => "/entry.js" })(
    new Request("http://localhost/fr/greet"),
  );
  const html = await res.text();
  // The #__denext_data island carries the fr catalog for client hydration.
  assertStringIncludes(html, "Bonjour, {name} !");
});

Deno.test("non-i18n apps embed no messages", async () => {
  const res = await app({ i18n: undefined, clientEntryFor: () => "/entry.js" })(
    new Request("http://localhost/greet"),
  );
  const html = await res.text();
  // With no catalog configured, useTranslations returns the key.
  assertStringIncludes(html, "<h1>greeting</h1>");
  assertEquals(html.includes(`"messages"`), false);
});

// ---- Client hydration path -------------------------------------------------

// deno-lint-ignore no-explicit-any
const asDoc = (d: FakeDocument): any => d;
// deno-lint-ignore no-explicit-any
const asEl = (e: FakeElement): any => e;

function TransProbe(): VNode {
  const t = useTranslations();
  return h("i", null, t("hi", { n: "A" }));
}

Deno.test("useTranslations reads the embedded catalog on the client", () => {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  // Minimal global document exposing the hydration island readData() looks for.
  g.document = {
    getElementById: (id: string) =>
      id === "__denext_data"
        ? { textContent: JSON.stringify({ messages: { hi: "Salut {n}" } }) }
        : null,
  };
  try {
    const { doc, container } = makeDom();
    setDocument(asDoc(doc));
    const root = createRoot(asEl(container));
    root.render(h(TransProbe, null));
    assertEquals(container.innerHTML, "<i>Salut A</i>");
    root.unmount();
  } finally {
    if (prev === undefined) delete (g as Record<string, unknown>).document;
    else g.document = prev;
  }
});
