import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  denextImageLoader,
  getImageRuntimeConfig,
  Image,
  imageConfigNeedsEmbed,
  type ImageProps,
  setImageRuntimeConfig,
} from "../src/runtime/image.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { setSsrHintSink } from "../src/compat/react-dom-preload.ts";
import { samplePng } from "./fixtures/sample-image.ts";
import {
  createGate,
  type FetchLike,
  fetchRemoteImage,
  GateOverloadError,
  isAllowedRemote,
  isForbiddenAddress,
  optimizeImage,
  probeImageDimensions,
} from "../src/server/image-optimizer.ts";

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

Deno.test("Image optimizes by default: built-in loader + responsive srcSet", async () => {
  setImageRuntimeConfig({ unoptimized: false });
  const html = await renderToString(h(Image, { src: "/hero.png", alt: "hero", sizes: "100vw" }));
  assertStringIncludes(html, "/_denext/image?url=%2Fhero.png"); // optimizer URL, not the raw src
  assertStringIncludes(html, "srcset=");
  assertStringIncludes(html, "3840w"); // a responsive image uses the device-size ladder
});

Deno.test("Image fixed width draws allowlisted 1x/2x srcSet widths", async () => {
  setImageRuntimeConfig({ unoptimized: false });
  const html = await renderToString(h(Image, { src: "/a.png", alt: "a", width: 500 }));
  // 500 → nearest allowlisted ≥500 is 640; 1000 → 1080 (both in the default allowlist).
  assertStringIncludes(html, "640w");
  assertStringIncludes(html, "1080w");
});

Deno.test("unoptimized prop renders a plain <img> with the raw src", async () => {
  setImageRuntimeConfig({ unoptimized: false });
  const html = await renderToString(
    h(Image, { src: "/raw.png", alt: "r", width: 800, unoptimized: true }),
  );
  assertStringIncludes(html, 'src="/raw.png"');
  assert(!html.includes("srcset"), "unoptimized must emit no srcset: " + html);
  assert(!html.includes("_denext/image"), "unoptimized must not use the optimizer: " + html);
});

Deno.test("images.unoptimized config makes every Image plain; island flag follows", async () => {
  setImageRuntimeConfig({ unoptimized: true });
  try {
    assertEquals(getImageRuntimeConfig().unoptimized, true);
    assertEquals(imageConfigNeedsEmbed(), true); // non-default → the client island is embedded
    const html = await renderToString(h(Image, { src: "/g.png", alt: "g", width: 800 }));
    assertStringIncludes(html, 'src="/g.png"');
    assert(!html.includes("srcset"), html);
  } finally {
    setImageRuntimeConfig({ unoptimized: false });
  }
  assertEquals(imageConfigNeedsEmbed(), false); // back to the default optimizing baseline
});

Deno.test("Image priority emits an SSR preload hint (LCP); non-priority does not", () => {
  const tags: string[] = [];
  setSsrHintSink((t) => tags.push(t));
  try {
    // Non-priority: no preload hint.
    Image({ src: "/a.png", alt: "a", width: 800, height: 600 } as ImageProps);
    assertEquals(tags.length, 0);

    // Priority + loader: a responsive preload with imagesrcset/imagesizes.
    Image(
      {
        src: "/hero.png",
        alt: "hero",
        width: 800,
        height: 600,
        priority: true,
        sizes: "100vw",
        loader: denextImageLoader,
      } as ImageProps,
    );
    assertEquals(tags.length, 1);
    assertStringIncludes(tags[0], `rel="preload"`);
    assertStringIncludes(tags[0], `as="image"`);
    assertStringIncludes(tags[0], `fetchpriority="high"`);
    assertStringIncludes(tags[0], `imagesrcset=`);
    assertStringIncludes(tags[0], `imagesizes="100vw"`);
  } finally {
    setSsrHintSink(null);
  }
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
    const png = samplePng();
    await Deno.writeFile(`${dir}/hero.png`, png);

    const res = await optimizeImage(
      new Request("http://x/_denext/image?url=/hero.png&w=128&q=70"),
      { publicDir: dir },
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/webp");
    assert((await res.arrayBuffer()).byteLength > 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("probeImageDimensions reads header dims without decoding (SEC-M1)", () => {
  // PNG: 8-byte sig, IHDR width@16 / height@20 (BE u32). Claim 40000×40000.
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(png.buffer).setUint32(16, 40000);
  new DataView(png.buffer).setUint32(20, 40000);
  assertEquals(probeImageDimensions(png), { width: 40000, height: 40000 });

  // GIF: "GIF89a", width@6 / height@8 (LE u16).
  const gif = new Uint8Array(10);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  new DataView(gif.buffer).setUint16(6, 1234, true);
  new DataView(gif.buffer).setUint16(8, 5678, true);
  assertEquals(probeImageDimensions(gif), { width: 1234, height: 5678 });

  // JPEG: FFD8, an APP0 segment, then SOF0 carrying 800×600.
  const jpeg = new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00, // APP0, len=4
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0, len=17, precision
    0x02,
    0x58, // height = 600
    0x03,
    0x20, // width = 800
    0x00,
    0x00,
    0x00, // trailing so the loop has room
  ]);
  assertEquals(probeImageDimensions(jpeg), { width: 800, height: 600 });

  // A non-image (or truncated header) is unrecognized → null.
  assertEquals(probeImageDimensions(new Uint8Array([1, 2, 3, 4])), null);
});

Deno.test("optimizeImage rejects a decompression bomb from its header (SEC-M1)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_bomb_" });
  try {
    // A tiny PNG whose IHDR claims 40000×40000 — never actually decoded.
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    new DataView(png.buffer).setUint32(16, 40000);
    new DataView(png.buffer).setUint32(20, 40000);
    await Deno.writeFile(`${dir}/bomb.png`, png);
    const res = await optimizeImage(
      new Request("http://x/_denext/image?url=/bomb.png&w=128&q=70"),
      { publicDir: dir },
    );
    assertEquals(res.status, 413);
    await res.body?.cancel();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("optimizeImage rejects a non-allowlisted remote host (SSRF guard)", async () => {
  const res = await optimizeImage(
    new Request("http://x/_denext/image?url=https://evil.example/a.png&w=128"),
    { publicDir: "/tmp" },
  );
  assertEquals(res.status, 404);
});

Deno.test("optimizeImage rejects a width outside the allowlist before any load (SEC-M2)", async () => {
  // A width not in deviceSizes ∪ imageSizes is refused with 400 *before* the source
  // is loaded/decoded — this is what bounds the endpoint's distinct-work surface.
  for (const w of [1, 7, 100, 333, 4000, 3841]) {
    const res = await optimizeImage(
      new Request(`http://x/_denext/image?url=/hero.png&w=${w}`),
      { publicDir: "/does-not-exist" },
    );
    assertEquals(res.status, 400, `w=${w} must be rejected (not in the allowlist)`);
    await res.body?.cancel();
  }
  // An allowlisted width gets past the width gate (404 here: the source is absent,
  // but crucially not the 400 the width gate would have returned).
  const ok = await optimizeImage(
    new Request("http://x/_denext/image?url=/hero.png&w=640"),
    { publicDir: "/does-not-exist" },
  );
  assertEquals(ok.status, 404, "an allowlisted width passes the width gate");
  await ok.body?.cancel();
});

Deno.test("createGate serializes work beyond its concurrency limit (SEC-M2)", async () => {
  const gate = createGate(2);
  const r1 = await gate();
  const r2 = await gate();
  // A third acquire at capacity must block until a slot frees.
  let a3 = false;
  const p3 = gate().then((r) => {
    a3 = true;
    return r;
  });
  await Promise.resolve(); // flush microtasks — still blocked
  assert(!a3, "third acquire blocks while both slots are held");
  r1(); // free a slot → the waiter is handed it
  const r3 = await p3;
  assert(a3, "third acquire proceeds once a slot frees");
  r2();
  r3();
  // The gate is reusable after full drain.
  const r4 = await gate();
  r4();
});

Deno.test("createGate sheds over-cap intake with GateOverloadError instead of unbounded queueing (M3)", async () => {
  // 1 slot, at most 2 queued waiters.
  const gate = createGate(1, 2);
  const held = await gate(); // occupies the only slot
  const w1 = gate(); // queued (1/2)
  const w2 = gate(); // queued (2/2)
  // The queue is full → the next acquire is rejected immediately, not queued.
  await assertRejects(() => gate(), GateOverloadError);

  // Draining the slot hands it to the queued waiters in FIFO order; no leak.
  held();
  (await w1)();
  (await w2)();
  // Reusable after full drain.
  const again = await gate();
  again();
});

Deno.test("optimizeImage sheds with 503 + Retry-After when the gate is saturated (M2/M3)", async () => {
  // A tiny gate whose slot we hold, with a full waiter queue, forces the endpoint
  // to shed the next request BEFORE it loads any source bytes.
  const gate = createGate(1, 0); // 1 slot, no queue → immediate shed once full
  const held = await gate();
  try {
    // Drive the endpoint through the SAME gate via the injected seam.
    const res = await optimizeImage(
      new Request("http://x/_denext/image?url=https://cdn.example.com/a.png&w=640"),
      { allowedHosts: ["cdn.example.com"] },
      gate,
    );
    assertEquals(res.status, 503, "over-cap image request is shed");
    assertEquals(res.headers.get("retry-after"), "1");
    await res.body?.cancel();
  } finally {
    held();
  }
});

Deno.test("optimizeImage honors a custom deviceSizes/imageSizes allowlist (SEC-M2)", async () => {
  // A config override replaces the default set: the default 640 is now refused,
  // and the custom 500 is accepted (reaching the source-load 404).
  const opts = { publicDir: "/does-not-exist", deviceSizes: [500], imageSizes: [20] };
  const rejected = await optimizeImage(
    new Request("http://x/_denext/image?url=/hero.png&w=640"),
    opts,
  );
  assertEquals(rejected.status, 400, "640 is no longer allowed under the custom set");
  await rejected.body?.cancel();
  for (const w of [500, 20]) {
    const res = await optimizeImage(
      new Request(`http://x/_denext/image?url=/hero.png&w=${w}`),
      opts,
    );
    assertEquals(res.status, 404, `custom-allowed w=${w} passes the width gate`);
    await res.body?.cancel();
  }
});

Deno.test("image remote allowlist: domains (exact) + remotePatterns (wildcard/protocol/path)", () => {
  const u = (s: string) => new URL(s);
  // Exact-host domains.
  assert(
    isAllowedRemote(u("https://cdn.example.com/a.png"), { allowedHosts: ["cdn.example.com"] }),
  );
  assert(!isAllowedRemote(u("https://evil.com/a.png"), { allowedHosts: ["cdn.example.com"] }));
  // remotePatterns: protocol + wildcard subdomain + pathname prefix.
  const remotePatterns = [{ protocol: "https", hostname: "*.example.com", pathname: "/img/" }];
  assert(isAllowedRemote(u("https://a.example.com/img/x.png"), { remotePatterns }));
  assert(
    !isAllowedRemote(u("https://example.com/img/x.png"), { remotePatterns }),
    "apex excluded by *.",
  );
  assert(
    !isAllowedRemote(u("http://a.example.com/img/x.png"), { remotePatterns }),
    "protocol enforced",
  );
  assert(
    !isAllowedRemote(u("https://a.example.com/other/x.png"), { remotePatterns }),
    "pathname enforced",
  );
  // Default: nothing remote allowed (SSRF-safe).
  assert(!isAllowedRemote(u("https://cdn.example.com/a.png"), {}));
});

Deno.test("isForbiddenAddress blocks loopback/private/link-local/metadata hosts", () => {
  for (
    const bad of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "100.64.0.1", // CGNAT
      "224.0.0.1", // multicast
      "[::1]",
      "::1",
      "fd00::1", // unique-local
      "fe80::1", // link-local
      "::ffff:127.0.0.1", // IPv4-mapped loopback
    ]
  ) {
    assert(isForbiddenAddress(bad), `should block ${bad}`);
  }
  for (const ok of ["example.com", "cdn.example.com", "8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
    assert(!isForbiddenAddress(ok), `should allow ${ok}`);
  }
});

// A fake fetch: routes by href to a scripted response (redirect / body / headers).
function fakeFetch(routes: Record<string, () => Response>): FetchLike {
  return (url: URL) => {
    const r = routes[url.href];
    if (!r) return Promise.resolve(new Response("nope", { status: 404 }));
    return Promise.resolve(r());
  };
}

Deno.test("fetchRemoteImage refuses a redirect to a non-allowlisted host (SSRF)", async () => {
  const opts = { allowedHosts: ["cdn.example.com"] };
  const fetchImpl = fakeFetch({
    "https://cdn.example.com/a.png": () =>
      new Response(null, { status: 302, headers: { location: "https://evil.example/b.png" } }),
    "https://evil.example/b.png": () => new Response(new Uint8Array([1, 2, 3])),
  });
  const out = await fetchRemoteImage(new URL("https://cdn.example.com/a.png"), opts, fetchImpl);
  assertEquals(out, null);
});

Deno.test("fetchRemoteImage follows a redirect to another allowlisted host", async () => {
  const opts = { allowedHosts: ["cdn.example.com", "img.example.com"] };
  const fetchImpl = fakeFetch({
    "https://cdn.example.com/a.png": () =>
      new Response(null, { status: 302, headers: { location: "https://img.example.com/b.png" } }),
    "https://img.example.com/b.png": () => new Response(new Uint8Array([9, 9, 9])),
  });
  const out = await fetchRemoteImage(new URL("https://cdn.example.com/a.png"), opts, fetchImpl);
  assertEquals(out, new Uint8Array([9, 9, 9]));
});

Deno.test("fetchRemoteImage refuses a redirect to a private/metadata IP even if allowlisted", async () => {
  const opts = { allowedHosts: ["cdn.example.com", "169.254.169.254"] };
  const fetchImpl = fakeFetch({
    "https://cdn.example.com/a.png": () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
  });
  const out = await fetchRemoteImage(new URL("https://cdn.example.com/a.png"), opts, fetchImpl);
  assertEquals(out, null);
});

Deno.test("fetchRemoteImage rejects an oversized declared content-length", async () => {
  const opts = { allowedHosts: ["cdn.example.com"] };
  const fetchImpl = fakeFetch({
    "https://cdn.example.com/a.png": () =>
      new Response(new Uint8Array([1]), {
        headers: { "content-length": String(999 * 1024 * 1024) },
      }),
  });
  const out = await fetchRemoteImage(new URL("https://cdn.example.com/a.png"), opts, fetchImpl);
  assertEquals(out, null);
});

Deno.test("fetchRemoteImage stops after too many redirects", async () => {
  const opts = { allowedHosts: ["cdn.example.com"] };
  const fetchImpl: FetchLike = (url) =>
    Promise.resolve(
      new Response(null, { status: 302, headers: { location: url.href } }), // self-redirect loop
    );
  const out = await fetchRemoteImage(new URL("https://cdn.example.com/a.png"), opts, fetchImpl);
  assertEquals(out, null);
});
