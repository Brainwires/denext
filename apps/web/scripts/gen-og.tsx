// Generate the static Open Graph share image (public/og.png, 1200x630) with denext's own
// ImageResponse (satori + resvg, bundled font — offline). Run once; commit the PNG.
//
//   deno run -A scripts/gen-og.tsx
//
// Referenced site-wide from app/layout.tsx (openGraph.image / twitter.image).

import { ImageResponse as ImageResponseValue } from "denext/server";

// ImageResponse is exported with a non-constructable public type; it IS a class at runtime.
const ImageResponse = ImageResponseValue as unknown as new (
  element: unknown,
  options: Record<string, unknown>,
) => { arrayBuffer(): Promise<ArrayBuffer> };

const OUT = new URL("../public/og.png", import.meta.url).pathname;

const card = (
  <div
    style={{
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      background: "#0a0c11",
      color: "#e8ebf1",
      padding: "72px 80px",
      fontFamily: "sans-serif",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        fontSize: 44,
        fontWeight: 700,
      }}
    >
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          background: "#7aa2ff",
          marginRight: 18,
        }}
      />
      <span>denext</span>
    </div>
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          fontSize: 68,
          fontWeight: 700,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
        }}
      >
        A React framework
      </div>
      <div
        style={{
          display: "flex",
          fontSize: 68,
          fontWeight: 700,
          lineHeight: 1.05,
          letterSpacing: "-0.02em",
        }}
      >
        <span>for&nbsp;</span>
        <span style={{ color: "#7aa2ff" }}>Deno</span>
        <span>.</span>
      </div>
      <div
        style={{ fontSize: 30, color: "#9aa4b4", marginTop: 26, maxWidth: 900 }}
      >
        The Next.js App Router, reimplemented — zero-npm runtime, Server Components, and pages that
        ship 0 KB of JavaScript.
      </div>
    </div>
    <div
      style={{
        display: "flex",
        alignItems: "center",
        fontSize: 26,
        color: "#58e0b0",
      }}
    >
      <span
        style={{
          border: "1px solid #232833",
          borderRadius: 999,
          padding: "8px 20px",
        }}
      >
        0 KB JavaScript
      </span>
      <span style={{ color: "#9aa4b4", marginLeft: 24 }}>denext.dev</span>
    </div>
  </div>
);

const res = new ImageResponse(card, {
  width: 1200,
  height: 630,
  offline: true,
});
const bytes = new Uint8Array(await res.arrayBuffer());
await Deno.writeFile(OUT, bytes);
console.log(`og image: ${bytes.length} bytes → ${OUT}`);
