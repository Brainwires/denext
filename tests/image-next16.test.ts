// Part D: next/image Next-16 alignment — quality coercion, format/AVIF
// negotiation, minimumCacheTTL, localPatterns, dangerouslyAllowLocalIP, and the
// dropped `16` default image size.

import { assert, assertEquals } from "@std/assert";
import {
  coerceQuality,
  DEFAULT_IMAGE_SIZES,
  type FetchLike,
  fetchRemoteImage,
  isAllowedLocal,
  negotiateFormat,
  optimizeImage,
} from "../src/server/image-optimizer.ts";
import { samplePng } from "./fixtures/sample-image.ts";

// AVIF output uses denext's first-party `@denext/avif` codec (a workspace member,
// zero npm), so it resolves in-repo and this test runs on CI. The guard stays as a
// belt-and-suspenders skip if the package can't be resolved (e.g. a stripped build).
let avifAvailable = false;
try {
  const spec = "@denext/avif";
  await import(spec);
  avifAvailable = true;
} catch { /* @denext/avif unresolvable — AVIF test self-skips */ }

Deno.test("D2: coerceQuality snaps to the nearest allowed value", () => {
  assertEquals(coerceQuality(70, [75]), 75);
  assertEquals(coerceQuality(50, [40, 75, 90]), 40);
  assertEquals(coerceQuality(80, [40, 75, 90]), 75);
  assertEquals(coerceQuality(100, [40, 75, 90]), 90);
});

Deno.test("D3: negotiateFormat picks AVIF only when configured AND accepted", () => {
  assertEquals(
    negotiateFormat("image/avif,image/webp,*/*", ["image/avif", "image/webp"]),
    "image/avif",
  );
  // Not configured → webp even if accepted.
  assertEquals(negotiateFormat("image/avif", ["image/webp"]), "image/webp");
  // Configured but not accepted → webp fallback.
  assertEquals(negotiateFormat("image/webp,*/*", ["image/avif", "image/webp"]), "image/webp");
  assertEquals(negotiateFormat(null, ["image/avif", "image/webp"]), "image/webp");
});

Deno.test("D4: isAllowedLocal enforces pathname glob + exact query", () => {
  // No patterns → everything allowed (default).
  assert(isAllowedLocal("/anything.png?x=1"));
  const patterns = [{ pathname: "/assets/**", search: "" }];
  assert(isAllowedLocal("/assets/a/b.png", patterns), "matches glob, empty query");
  assert(!isAllowedLocal("/assets/a.png?v=1", patterns), "query not allowed by search: ''");
  assert(!isAllowedLocal("/other/a.png", patterns), "pathname outside the glob");
  // A search pattern that requires a specific query.
  const withQuery = [{ pathname: "/img/*.png", search: "v=1" }];
  assert(isAllowedLocal("/img/logo.png?v=1", withQuery));
  assert(!isAllowedLocal("/img/logo.png?v=2", withQuery));
  assert(!isAllowedLocal("/img/deep/logo.png?v=1", withQuery), "* is one segment only");
});

Deno.test("D2: 16 was dropped from the default image sizes (w=16 rejected)", async () => {
  assert(!DEFAULT_IMAGE_SIZES.includes(16));
  const res = await optimizeImage(
    new Request("http://x/_denext/image?url=/hero.png&w=16"),
    { publicDir: "/nope" },
  );
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("D2: minimumCacheTTL + Vary:Accept are emitted on the response", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_img16_" });
  try {
    await Deno.writeFile(`${dir}/hero.png`, samplePng());
    const res = await optimizeImage(
      new Request("http://x/_denext/image?url=/hero.png&w=128"),
      { publicDir: dir, minimumCacheTTL: 3600 },
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/webp");
    assertEquals(res.headers.get("cache-control"), "public, max-age=3600, immutable");
    assertEquals(res.headers.get("vary"), "Accept");
    await res.body?.cancel();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "D3: AVIF is served when configured and the client accepts it",
  ignore: !avifAvailable, // first-party `@denext/avif` codec (workspace member)
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "denext_avif_" });
    try {
      await Deno.writeFile(`${dir}/hero.png`, samplePng());
      const res = await optimizeImage(
        new Request("http://x/_denext/image?url=/hero.png&w=128&q=60", {
          headers: { accept: "image/avif,image/webp,*/*" },
        }),
        { publicDir: dir, formats: ["image/avif", "image/webp"], qualities: [60] },
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "image/avif");
      const bytes = new Uint8Array(await res.arrayBuffer());
      // AVIF files carry an "ftyp" box at bytes 4..8.
      assertEquals(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]), "ftyp");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("D4: localPatterns rejects a non-matching local source (404)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_local_" });
  try {
    await Deno.writeFile(`${dir}/secret.png`, samplePng());
    const opts = { publicDir: dir, localPatterns: [{ pathname: "/public/**" }] };
    const rejected = await optimizeImage(
      new Request("http://x/_denext/image?url=/secret.png&w=128"),
      opts,
    );
    assertEquals(rejected.status, 404, "outside localPatterns → refused");
    await rejected.body?.cancel();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("D4: dangerouslyAllowLocalIP gates the SSRF address guard for remote sources", async () => {
  const png = samplePng();
  const fakeFetch: FetchLike = () =>
    Promise.resolve(new Response(png as BodyInit, { status: 200 }));
  const url = new URL("http://127.0.0.1/a.png");
  const base = { allowedHosts: ["127.0.0.1"] as string[] };

  // Default: a loopback source is refused by the address guard (returns null).
  const blocked = await fetchRemoteImage(url, base, fakeFetch);
  assertEquals(blocked, null, "loopback refused without the escape hatch");

  // With the (dangerous) escape hatch, the loopback source is fetched.
  const allowed = await fetchRemoteImage(
    url,
    { ...base, dangerouslyAllowLocalIP: true },
    fakeFetch,
  );
  assert(allowed !== null && allowed.byteLength > 0, "escape hatch allows the loopback fetch");
});
