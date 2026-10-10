// A compatibility-mode server bundle carries its own copy of the denext runtime, so the
// process-wide settings the server entry or `denext export` makes — the image config, the
// basePath — must reach every copy: a second instance of the module (imported under another
// URL) sees what the first one set.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import * as image from "../src/runtime/image.ts";
import * as navigation from "../src/client/navigation.ts";

Deno.test("the image config reaches another copy of the runtime", async () => {
  const copy = await import("../src/runtime/image.ts?runtime-copy");
  const before = image.getImageRuntimeConfig();
  try {
    image.setImageRuntimeConfig({ unoptimized: true });
    assertEquals(copy.getImageRuntimeConfig().unoptimized, true);
    // The copy's <Image> renders the plain <img> a static export needs, not the optimizer URL.
    const html = await renderToString(
      h(copy.Image, { src: "/a.png", alt: "", width: 10, height: 10 }),
    );
    assertStringIncludes(html, `src="/a.png"`);
    // The embed check compares by value: the copy's default arrays are not the original's.
    image.setImageRuntimeConfig({ unoptimized: false });
    assertEquals(copy.imageConfigNeedsEmbed(), false);
  } finally {
    image.setImageRuntimeConfig(before);
  }
});

Deno.test("the basePath reaches another copy of the runtime's <Link>", async () => {
  const copy = await import("../src/client/navigation.ts?runtime-copy");
  try {
    navigation.setBasePath("/base/");
    const html = await renderToString(h(copy.Link, { href: "/about", children: "about" }));
    assertStringIncludes(html, `href="/base/about"`);
  } finally {
    navigation.setBasePath("");
  }
});
