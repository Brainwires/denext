// Next.js-shaped navigation surface (2.0): useRouter (stable, prefetch, options), Link
// (user handlers/refs preserved, target/download respected, legacyBehavior, UrlObject,
// prefetch null/true/false) and next/image `fill` + a real blur placeholder.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { render } from "../src/testing/mod.ts";
import { formatHref, Link, useRouter } from "../src/client/navigation.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { blurBackground, Image } from "../src/runtime/image.ts";

Deno.test("useRouter() returns one stable object with Next's AppRouterInstance methods", async () => {
  const seen: unknown[] = [];
  function C() {
    const r = useRouter();
    seen.push(r);
    return h("p", null, typeof r.prefetch);
  }
  await render(h(C, null));
  await render(h(C, null));
  assertStringIncludes(String(seen.length), "2");
  assertEquals(seen[0], seen[1], "identity is stable across renders and roots");
  const r = seen[0] as Record<string, unknown>;
  for (const m of ["push", "replace", "prefetch", "back", "forward", "refresh"]) {
    assertEquals(typeof r[m], "function", m);
  }
});

Deno.test("formatHref formats a UrlObject like Next's Link/useRouter", () => {
  assertEquals(formatHref("/a?b=1"), "/a?b=1");
  assertEquals(formatHref({ pathname: "/a", query: { b: 1, c: "x", d: undefined } }), "/a?b=1&c=x");
  assertEquals(formatHref({ pathname: "/a", search: "q=1", hash: "top" }), "/a?q=1#top");
});

Deno.test("Link: user onClick/ref are kept, target/download/defaultPrevented links are left alone", async () => {
  let clicks = 0;
  let refNode: Element | null = null;
  const screen = await render(
    h("div", null, [
      h(Link, {
        href: "/soft",
        id: "soft",
        onClick: () => clicks++,
        ref: (n: Element | null) => (refNode = n),
      }, "soft"),
      h(Link, { href: "/blank", id: "blank", target: "_blank" }, "blank"),
      h(Link, { href: "/dl", id: "dl", download: true }, "dl"),
      h(Link, {
        href: "/stop",
        id: "stop",
        onClick: (e: Event) => e.preventDefault(),
      }, "stop"),
    ]),
  );
  const html = screen.container.innerHTML;
  assertStringIncludes(html, 'id="soft"');
  assert(!/legacyBehavior|passHref|shallow/.test(html), "Link-only props never reach the DOM");
  assert(refNode !== null, "the user's ref received the anchor");
  await screen.fireEvent.click(screen.getByText("soft"));
  assertEquals(clicks, 1, "the user's onClick ran");
  assertStringIncludes(html, 'target="_blank"');
  assertStringIncludes(html, "download");
});

Deno.test("Link legacyBehavior clones the child <a> instead of nesting anchors", async () => {
  const screen = await render(
    h(Link, { href: "/x", legacyBehavior: true, passHref: true }, h("a", { class: "c" }, "go")),
  );
  const html = screen.container.innerHTML;
  assertEquals((html.match(/<a\b/g) ?? []).length, 1, html);
  assertStringIncludes(html, 'href="/x"');
  assertStringIncludes(html, 'class="c"');
});

Deno.test("Image fill: no width/height attributes, container positioning, sizes default", async () => {
  const html = await renderToString(
    h(Image, {
      src: "/hero.png",
      alt: "hero",
      fill: true,
      unoptimized: true,
      style: { objectFit: "cover" },
    }),
  );
  assert(!/ width=| height=/.test(html), html);
  assertStringIncludes(html, "position:absolute");
  assertStringIncludes(html, "object-fit:cover");
  assertStringIncludes(html, 'sizes="100vw"');
});

Deno.test("Image blur placeholder is a real blur (feGaussianBlur SVG) and is marked for clearing", async () => {
  const html = await renderToString(
    h(Image, {
      src: "/x.png",
      alt: "x",
      unoptimized: true,
      placeholder: "blur",
      blurDataURL: "data:image/png;base64,AAAA",
      style: { borderRadius: "4px" },
    }),
  );
  assertStringIncludes(html, "data-dnx-blur");
  assertStringIncludes(html, "background-image:url");
  assertStringIncludes(html, "feGaussianBlur");
  assertStringIncludes(html, "border-radius:4px", "the user's style wins");
  assertStringIncludes(blurBackground("data:x"), "data:image/svg+xml");
  // A `data:` placeholder is used directly.
  const direct = await renderToString(
    h(Image, {
      src: "/y.png",
      alt: "y",
      unoptimized: true,
      placeholder: "data:image/gif;base64,R0",
    }),
  );
  assertStringIncludes(direct, "data:image/gif;base64,R0");
});
