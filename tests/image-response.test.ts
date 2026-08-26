import { assert, assertEquals, assertRejects } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { ImageResponse } from "../src/server/image-response.ts";

// `next/og` renders through denext's first-party `@denext/og` codec (a workspace
// member locally, JSR when published). It self-skips only if that fails to resolve.
let ogAvailable = false;
try {
  await import("@denext/og");
  ogAvailable = true;
} catch { /* @denext/og unresolvable — test self-skips */ }

function Badge({ label }: { label: string }) {
  return h("div", {
    style: {
      display: "flex",
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      background: "#0b1020",
      color: "white",
      fontSize: 48,
    },
  }, label);
}

const PNG_MAGIC = [137, 80, 78, 71];

Deno.test({
  name: "ImageResponse renders denext JSX to a PNG response",
  ignore: !ogAvailable, // first-party `@denext/og` codec
  fn: async () => {
    const res = ImageResponse(h(Badge, { label: "denext" }), { width: 400, height: 200 });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number.
    assertEquals([bytes[0], bytes[1], bytes[2], bytes[3]], PNG_MAGIC);
    assert(bytes.length > 1000, "expected a non-trivial PNG");
  },
});

Deno.test({
  name: "ImageResponse awaits an async Server Component in the tree",
  ignore: !ogAvailable,
  fn: async () => {
    async function AsyncBadge() {
      await Promise.resolve(); // real async work (e.g. a data fetch)
      return h(Badge, { label: "async" });
    }
    const res = ImageResponse(h(AsyncBadge, null), { width: 300, height: 150 });
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals([bytes[0], bytes[1], bytes[2], bytes[3]], PNG_MAGIC);
  },
});

Deno.test({
  name: "ImageResponse: the `tw` (Tailwind) prop renders",
  ignore: !ogAvailable,
  fn: async () => {
    const el = h(
      "div",
      {
        tw: "flex items-center justify-center w-full h-full bg-black text-white",
        style: { width: "100%", height: "100%" },
      },
      "tw",
    );
    const res = ImageResponse(el, { width: 300, height: 150 });
    const bytes = new Uint8Array(await res.arrayBuffer());
    assertEquals([bytes[0], bytes[1], bytes[2], bytes[3]], PNG_MAGIC);
  },
});

Deno.test({
  name: "ImageResponse offline: renders a covered glyph, errors on an uncovered one (no network)",
  ignore: !ogAvailable,
  fn: async () => {
    // Latin text is covered by the bundled font → renders fully offline.
    const ok = ImageResponse(h(Badge, { label: "Hello" }), {
      width: 200,
      height: 100,
      offline: true,
    });
    const bytes = new Uint8Array(await ok.arrayBuffer());
    assertEquals([bytes[0], bytes[1], bytes[2], bytes[3]], PNG_MAGIC);

    // An uncovered glyph would normally fetch a font from the network; offline makes it
    // throw instead of phoning home — the body errors.
    const bad = ImageResponse(h(Badge, { label: "日本語" }), {
      width: 200,
      height: 100,
      offline: true,
    });
    await assertRejects(() => bad.arrayBuffer());
  },
});
