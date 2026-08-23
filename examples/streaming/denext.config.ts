import type { DenextConfig } from "denext/server";

export default {
  experimental: {
    // This example demonstrates BOTH delivery modes side by side, so it pins the
    // page path to buffered SSR: `/dashboard` fully resolves its Suspense'd async
    // Server Components server-side before sending HTML, while `/stream` (a Route
    // Handler using renderToReadableStream) shows true out-of-order streaming.
    // Framework-wide, incremental streaming is ON by default; set it false here so
    // the buffered/streamed contrast stays crisp. Drop this to let pages stream.
    streaming: false,
  },
} satisfies DenextConfig;
