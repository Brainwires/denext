import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { Image } from "../src/runtime/image.ts";
import { Script } from "../src/runtime/script.ts";
import { FontFace, localFont } from "../src/runtime/font.ts";
import { prefetch } from "../src/client/navigation.ts";
import { draftMode } from "../src/server/request-context.ts";
import { createRequestContext, runWithContext } from "../src/server/request-context.ts";

// ---- <Image> ---------------------------------------------------------------

Deno.test("Image renders a lazy, async-decoded img by default", async () => {
  const html = await renderToString(
    h(Image, { src: "/a.png", alt: "a", width: 100, height: 50 }),
  );
  assertStringIncludes(html, `src="/a.png"`);
  assertStringIncludes(html, `alt="a"`);
  assertStringIncludes(html, `loading="lazy"`);
  assertStringIncludes(html, `decoding="async"`);
  assertStringIncludes(html, `width="100"`);
});

Deno.test("Image with priority loads eagerly and maps srcSet -> srcset", async () => {
  const html = await renderToString(
    h(Image, { src: "/a.png", alt: "a", priority: true, srcSet: "/a2.png 2x" }),
  );
  assertStringIncludes(html, `loading="eager"`);
  assertStringIncludes(html, `fetchpriority="high"`);
  assertStringIncludes(html, `srcset="/a2.png 2x"`);
});

// ---- <Script> --------------------------------------------------------------

Deno.test("Script maps strategy to defer", async () => {
  const after = await renderToString(h(Script, { src: "/s.js" }));
  assertStringIncludes(after, `<script src="/s.js" defer>`);

  const before = await renderToString(
    h(Script, { src: "/s.js", strategy: "beforeInteractive" }),
  );
  assert(!before.includes("defer"));

  const lazy = await renderToString(h(Script, { src: "/s.js", strategy: "lazyOnload" }));
  assertStringIncludes(lazy, `fetchpriority="low"`);
});

Deno.test("Script renders inline source verbatim", async () => {
  const html = await renderToString(h(Script, { children: "console.log(1 < 2)" }));
  assertStringIncludes(html, "<script>console.log(1 < 2)</script>");
});

// ---- localFont -------------------------------------------------------------

Deno.test("localFont builds @font-face CSS and a style object", () => {
  const inter = localFont({
    family: "Inter",
    src: "/fonts/inter.woff2",
    weight: "400",
    fallback: ["sans-serif"],
  });
  assertStringIncludes(inter.css, "@font-face{");
  assertStringIncludes(inter.css, `font-family:"Inter";`);
  assertStringIncludes(inter.css, `format("woff2")`);
  assertStringIncludes(inter.css, "font-weight:400;");
  assertEquals(inter.style.fontFamily, `"Inter", sans-serif`);
});

Deno.test("FontFace renders the CSS into a <style> tag", async () => {
  const inter = localFont({ family: "Inter", src: "/fonts/inter.woff2" });
  const html = await renderToString(h(FontFace, { font: inter }));
  assertStringIncludes(html, "<style>@font-face{");
  assertStringIncludes(html, `font-family:"Inter";`);
});

// ---- prefetch --------------------------------------------------------------

Deno.test("prefetch is a no-op on the server", () => {
  // No document/location -> returns without throwing.
  prefetch("/somewhere");
});

// ---- draftMode -------------------------------------------------------------

Deno.test("draftMode reflects the cookie and can toggle it", () => {
  // Enabled when the cookie is present.
  runWithContext(
    createRequestContext(
      new Request("http://x/", { headers: { cookie: "__denext_draft=1" } }),
    ),
    () => assertEquals(draftMode().isEnabled, true),
  );

  // enable() queues a Set-Cookie on the response.
  const ctx = createRequestContext(new Request("http://x/"));
  runWithContext(ctx, () => {
    const dm = draftMode();
    assertEquals(dm.isEnabled, false);
    dm.enable();
  });
  const setCookies = ctx.outgoingHeaders.getSetCookie().join(";");
  assertStringIncludes(setCookies, "__denext_draft=1");
  assertStringIncludes(setCookies, "HttpOnly");
});
