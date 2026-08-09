import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { h } from "../src/jsx/jsx-runtime.ts";
import { denextImageLoader, Image } from "../src/runtime/image.ts";
import { renderToString } from "../src/jsx/render-to-string.ts";
import { ImageResponse } from "../src/server/image-response.ts";
import {
  type FetchLike,
  fetchRemoteImage,
  isAllowedRemote,
  isForbiddenAddress,
  optimizeImage,
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
