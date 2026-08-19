// Deep behavior of the layout→page metadata/viewport merge (src/server/
// render-page.ts): nested objects shallow-merge, scalars override left-to-right,
// `head` concatenates, and `undefined` never clobbers an inherited value.

import { assert, assertEquals } from "@std/assert";
import { mergeMetadata, mergeViewport } from "../src/server/render-page.ts";
import type { Metadata } from "../src/server/types.ts";

Deno.test("scalars override left-to-right; later layers win", () => {
  const m = mergeMetadata([
    { title: "Root", description: "root desc" },
    { title: "Page" }, // description omitted → inherited
  ]);
  assertEquals(m.title, "Page");
  assertEquals(m.description, "root desc");
});

Deno.test("an undefined field never clobbers an inherited value", () => {
  const m = mergeMetadata([
    { title: "Root" },
    { title: undefined } as Metadata, // explicit undefined must be a no-op
  ]);
  assertEquals(m.title, "Root");
});

Deno.test("openGraph shallow-merges across layers", () => {
  const m = mergeMetadata([
    { openGraph: { title: "OG Root", siteName: "Site" } },
    { openGraph: { title: "OG Page", description: "og desc" } },
  ]);
  assertEquals(m.openGraph?.title, "OG Page", "overlapping key is overridden");
  assertEquals(m.openGraph?.siteName, "Site", "non-overlapping key is preserved");
  assertEquals(m.openGraph?.description, "og desc", "new key is added");
});

Deno.test("twitter and verification objects shallow-merge", () => {
  const m = mergeMetadata([
    { twitter: { site: "@root" }, verification: { google: "g1" } },
    { twitter: { creator: "@page" }, verification: { yandex: "y1" } },
  ]);
  assertEquals(m.twitter?.site, "@root");
  assertEquals(m.twitter?.creator, "@page");
  assertEquals(m.verification?.google, "g1");
  assertEquals(m.verification?.yandex, "y1");
});

Deno.test("icons and alternates objects shallow-merge", () => {
  const m = mergeMetadata([
    { icons: { icon: "/i.png" }, alternates: { canonical: "https://x/" } },
    { icons: { apple: "/a.png" }, alternates: { languages: { en: "https://x/en" } } },
  ]);
  assertEquals(m.icons?.icon, "/i.png");
  assertEquals(m.icons?.apple, "/a.png");
  assertEquals(m.alternates?.canonical, "https://x/");
  assert(m.alternates?.languages, "languages survives the merge");
});

Deno.test("head is concatenated across layers (not overwritten)", () => {
  const m = mergeMetadata([
    { head: "<link rel=preconnect>" },
    { head: "<meta name=x>" },
  ]);
  assertEquals(m.head, "<link rel=preconnect><meta name=x>");
});

Deno.test("keywords replace (arrays are not concatenated)", () => {
  const m = mergeMetadata([
    { keywords: ["a", "b"] },
    { keywords: ["c"] },
  ]);
  assertEquals(m.keywords, ["c"]);
});

Deno.test("metadataBase: the last defined value wins", () => {
  const m = mergeMetadata([
    { metadataBase: "https://root.example" },
    { metadataBase: "https://page.example" },
  ]);
  assertEquals(m.metadataBase, "https://page.example");
});

Deno.test("mergeViewport: later entries override earlier ones", () => {
  const v = mergeViewport([
    { themeColor: "#fff", initialScale: 1 },
    { themeColor: "#000" },
  ]);
  assertEquals(v.themeColor, "#000");
  assertEquals(v.initialScale, 1);
});

Deno.test("merging an empty list yields an empty object", () => {
  assertEquals(mergeMetadata([]), {});
  assertEquals(mergeViewport([]), {});
});
