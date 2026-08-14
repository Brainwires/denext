// Dynamic Open Graph image (next/og-style). The `opengraph-image` convention is
// served at /opengraph-image and its result auto-populates <meta property="og:image">.
// ImageResponse renders JSX (host elements + inline `style` only) to a PNG via
// @cf-wasm/og — satori for flexbox layout, resvg for rasterization — with a bundled
// default font, so there is nothing to configure.

import { ImageResponse } from "denext/server";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0b1020 0%, #1a2440 100%)",
        color: "white",
        fontSize: 64,
        fontWeight: 700,
      }}
    >
      <div>denext</div>
      <div
        style={{
          fontSize: 30,
          fontWeight: 400,
          marginTop: 12,
          color: "#9db4ff",
        }}
      >
        image optimization demo
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}
