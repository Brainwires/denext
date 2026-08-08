import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { denextImageLoader, Image } from "../src/runtime/image.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { ImageResponse } from "../src/server/image-response.ts";
import { optimizeImage } from "../src/server/image-optimizer.ts";

Deno.test("denextImageLoader builds an endpoint URL", () => {
  assertEquals(
    denextImageLoader({ src: "/a b.png", width: 640, quality: 80 }),
    "/_denext/image?url=%2Fa%20b.png&w=640&q=80",
  );
});

Deno.test("Image with a loader generates a responsive srcSet", async () => {
  const html = await renderToString(
    h(Image, { src: "/hero.png", alt: "hero", loader: denextImageLoader, widths: [640, 1080] }),
  );
  assertStringIncludes(html, "srcset=");
  assertStringIncludes(html, "w=640");
  assertStringIncludes(html, "1080w");
});

Deno.test("Image blur placeholder paints the blurDataURL behind the image", async () => {
  const html = await renderToString(
    h(Image, {
      src: "/x.png",
      alt: "x",
      placeholder: "blur",
      blurDataURL: "data:image/png;base64,AAAA",
    }),
  );
  assertStringIncludes(html, "background-image:url");
});

Deno.test("optimizeImage resizes a local asset to webp", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_img_" });
  try {
    const png = new Uint8Array(
      await ImageResponse(
        h("div", {
          style: { display: "flex", width: "100%", height: "100%", background: "#e74c3c" },
        }),
        { width: 300, height: 300 },
      ).arrayBuffer(),
    );
    await Deno.writeFile(`${dir}/hero.png`, png);

    const res = await optimizeImage(
      new Request("http://x/_denext/image?url=/hero.png&w=100&q=70"),
      { publicDir: dir },
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/webp");
    assert((await res.arrayBuffer()).byteLength > 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("optimizeImage rejects a non-allowlisted remote host (SSRF guard)", async () => {
  const res = await optimizeImage(
    new Request("http://x/_denext/image?url=https://evil.example/a.png&w=100"),
    { publicDir: "/tmp" },
  );
  assertEquals(res.status, 404);
});
