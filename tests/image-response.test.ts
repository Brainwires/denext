import { assert, assertEquals } from "@std/assert";
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

Deno.test({
  name: "ImageResponse renders denext JSX to a PNG response",
  ignore: !ogAvailable, // first-party `@denext/og` codec
  fn: async () => {
    const res = ImageResponse(h(Badge, { label: "denext" }), { width: 400, height: 200 });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG magic number.
    assertEquals([bytes[0], bytes[1], bytes[2], bytes[3]], [137, 80, 78, 71]);
    assert(bytes.length > 1000, "expected a non-trivial PNG");
  },
});
