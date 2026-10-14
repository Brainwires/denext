// `transformImageBytes`: the `/_denext/image` pipeline for bytes the caller already holds — the
// size allowlist, quality coercion, avif opt-in, fit-inside (never enlarging), the output cache,
// SVG / decompression-bomb refusal, AVIF sources (sized from `ispe` before decoding) and the
// concurrency gate.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  GateOverloadError,
  probeImageDimensions,
  transformImageBytes,
} from "../src/server/image-optimizer.ts";
import { isAvif, probeAvif } from "../src/server/image-avif.ts";
import { samplePng } from "./fixtures/sample-image.ts";

async function dims(
  res: Response,
): Promise<{ type: string | null; width: number; height: number }> {
  const bytes = await res.bytes();
  const { PhotonImage } = await import("@denext/photon");
  const img = PhotonImage.new_from_byteslice(bytes);
  try {
    return {
      type: res.headers.get("content-type"),
      width: img.get_width(),
      height: img.get_height(),
    };
  } finally {
    img.free();
  }
}

/** A PNG of `w` × `h` (solid). */
async function png(w: number, h: number): Promise<Uint8Array> {
  const { PhotonImage } = await import("@denext/photon");
  const img = new PhotonImage(new Uint8Array(w * h * 4).fill(200), w, h);
  try {
    return img.get_bytes();
  } finally {
    img.free();
  }
}

Deno.test("transformImageBytes: fits inside the box, keeps the aspect ratio, never enlarges", async () => {
  const wide = await png(400, 200);
  assertEquals(await dims(await transformImageBytes(wide, { width: 128 })), {
    type: "image/webp",
    width: 128,
    height: 64,
  });
  assertEquals(await dims(await transformImageBytes(wide, { height: 64 })), {
    type: "image/webp",
    width: 128,
    height: 64,
  });
  assertEquals(await dims(await transformImageBytes(wide, { width: 256, height: 32 })), {
    type: "image/webp",
    width: 64,
    height: 32,
  });
  assertEquals(await dims(await transformImageBytes(samplePng(), { width: 640 })), {
    type: "image/webp",
    width: 16,
    height: 16,
  });
});

Deno.test("transformImageBytes: sizes, formats and qualities are allowlisted", async () => {
  const src = samplePng();
  for (
    const [t, msg] of [
      [{}, "width or a height"],
      [{ width: 100 }, "size 100 is not allowed"],
      [{ width: 32, height: 5000 }, "size 5000 is not allowed"],
      [{ width: 32, format: "avif" }, "avif output is not enabled"],
      [{ width: 32, format: "gif" }, "format must be webp or avif"],
    ] as const
  ) {
    const res = await transformImageBytes(src, t as never);
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), msg);
  }
  const custom = await transformImageBytes(src, { width: 100 }, {
    images: { deviceSizes: [100], imageSizes: [] },
  });
  assertEquals(custom.status, 200);
  await custom.body?.cancel();
  const avif = await transformImageBytes(src, { width: 32, format: "avif", quality: 51 }, {
    images: { formats: ["image/avif"], qualities: [50, 90] },
  });
  assertEquals([avif.status, avif.headers.get("content-type")], [200, "image/avif"]);
  await avif.body?.cancel();
});

Deno.test("transformImageBytes: caches by identity, refuses SVG, bombs and garbage, sheds load", async () => {
  let gated = 0;
  const gate = () => {
    gated++;
    return Promise.resolve(() => {});
  };
  const first = await transformImageBytes(samplePng(), { width: 32 }, { cacheKey: "t/a@1" }, gate);
  const second = await transformImageBytes(new Uint8Array([1, 2, 3]), { width: 32 }, {
    cacheKey: "t/a@1",
  }, gate);
  assertEquals((await first.bytes()).byteLength, (await second.bytes()).byteLength);
  assertEquals(gated, 1, "the second call was served from the cache");

  const svg = await transformImageBytes(
    new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    { width: 32 },
  );
  assertEquals(svg.status, 400);
  await svg.body?.cancel();
  const bomb = samplePng().slice();
  new DataView(bomb.buffer).setUint32(16, 50_000); // IHDR width
  const big = await transformImageBytes(bomb, { width: 32 });
  assertEquals(big.status, 413);
  await big.body?.cancel();
  const garbage = await transformImageBytes(new Uint8Array([0, 1, 2, 3, 4, 5]), { width: 32 });
  assertEquals(garbage.status, 400);
  assertEquals(await garbage.text(), "image transform failed");
  const busy = await transformImageBytes(
    samplePng(),
    { width: 48 },
    {},
    () => Promise.reject(new GateOverloadError("full")),
  );
  assertEquals([busy.status, busy.headers.get("retry-after")], [503, "1"]);
  await busy.body?.cancel();
});

Deno.test("transformImageBytes: resize cover (centre crop), contain and fill; origin keeps the format", async () => {
  const wide = await png(400, 200);
  const box = { width: 128, height: 128 };
  assertEquals(await dims(await transformImageBytes(wide, { ...box, resize: "cover" })), {
    type: "image/webp",
    width: 128,
    height: 128,
  });
  assertEquals(await dims(await transformImageBytes(wide, { ...box, resize: "contain" })), {
    type: "image/webp",
    width: 128,
    height: 64,
  });
  assertEquals(await dims(await transformImageBytes(wide, { ...box, resize: "fill" })), {
    type: "image/webp",
    width: 128,
    height: 128,
  });
  // cover never enlarges: a box bigger than the source is cropped to what the source has.
  assertEquals(
    await dims(
      await transformImageBytes(await png(100, 50), { width: 256, height: 96, resize: "cover" }),
    ),
    { type: "image/webp", width: 100, height: 50 },
  );
  const origin = await transformImageBytes(wide, { width: 128, format: "origin" });
  assertEquals(origin.headers.get("content-type"), "image/png");
  const { PhotonImage } = await import("@denext/photon");
  const source = PhotonImage.new_from_byteslice(wide);
  const jpeg = source.get_bytes_jpeg(80);
  source.free();
  const fromJpeg = await transformImageBytes(jpeg, { width: 128, format: "origin", quality: 50 }, {
    maxDimension: 2500,
  });
  assertEquals((await dims(fromJpeg)).type, "image/jpeg");
  const bad = await transformImageBytes(wide, { width: 128, resize: "stretch" as "fill" });
  assertEquals(bad.status, 400);
});

Deno.test("transformImageBytes: maxDimension takes any size and quality up to the bound", async () => {
  const wide = await png(400, 200);
  const odd = await transformImageBytes(wide, { width: 77, height: 33, resize: "fill" }, {
    maxDimension: 2500,
  });
  assertEquals(await dims(odd), { type: "image/webp", width: 77, height: 33 });
  const notListed = await transformImageBytes(wide, { width: 77 });
  assertEquals(notListed.status, 400);
  assertEquals(
    (await transformImageBytes(wide, { width: 2501 }, { maxDimension: 2500 })).status,
    400,
  );
  assertEquals(
    (await transformImageBytes(wide, { width: 10, quality: 0 }, { maxDimension: 2500 })).status,
    400,
  );
});

/** An AVIF of `w` × `h` (solid), encoded by `@denext/avif`. */
async function avif(w: number, h: number): Promise<Uint8Array> {
  const { encode } = await import("@denext/avif");
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([40, 160, 220, 255], i);
  return new Uint8Array(await encode({ data: rgba, width: w, height: h }, { quality: 80 }));
}

/** The offset of the first `ispe` box's payload (after its type) in an AVIF file. */
function ispeAt(file: Uint8Array): number {
  for (let i = 4; i + 4 <= file.length; i++) {
    if (String.fromCharCode(...file.subarray(i, i + 4)) === "ispe") return i + 4;
  }
  throw new Error("no ispe box");
}

Deno.test("AVIF sources: recognised and sized from ispe without decoding", async () => {
  const file = await avif(400, 200);
  assertEquals(isAvif(file), true);
  assertEquals(isAvif(await png(4, 4)), false);
  assertEquals(isAvif(new Uint8Array(40)), false);
  assertEquals(probeAvif(file), { width: 400, height: 200 });
  assertEquals(probeImageDimensions(file), { width: 400, height: 200 });
  assertEquals(probeAvif(await png(4, 4)), null);
  // A truncated file keeps whatever boxes are whole; a box running past the end is not read.
  assertEquals(probeAvif(file.slice(0, 40)), null);
});

Deno.test("transformImageBytes: an AVIF source is resized and re-encoded; origin keeps AVIF", async () => {
  const file = await avif(400, 200);
  assertEquals(await dims(await transformImageBytes(file, { width: 128 })), {
    type: "image/webp",
    width: 128,
    height: 64,
  });
  assertEquals(
    await dims(await transformImageBytes(file, { width: 128, height: 128, resize: "cover" })),
    { type: "image/webp", width: 128, height: 128 },
  );
  const origin = await transformImageBytes(file, { width: 96, format: "origin" }, {
    maxDimension: 2500,
  });
  assertEquals([origin.status, origin.headers.get("content-type")], [200, "image/avif"]);
  const { decode } = await import("@denext/avif");
  const back = await decode(await origin.bytes());
  assertEquals([back.width, back.height], [96, 48]);
  const pixel = [...back.data.subarray(0, 4)];
  assert(Math.abs(pixel[0] - 40) < 12 && Math.abs(pixel[2] - 220) < 12, `colour ${pixel}`);
});

Deno.test("transformImageBytes: an AVIF declaring a bomb, no size or garbage is refused before decoding", async () => {
  const file = await avif(64, 32);
  const bomb = file.slice();
  new DataView(bomb.buffer).setUint32(ispeAt(bomb) + 4, 50_000); // ispe image_width
  const big = await transformImageBytes(bomb, { width: 32 });
  assertEquals([big.status, await big.text()], [413, "image too large"]);
  const unsized = file.slice();
  unsized.set([0x78, 0x78, 0x78, 0x78], ispeAt(unsized) - 4); // "ispe" → "xxxx"
  const noSize = await transformImageBytes(unsized, { width: 32 });
  assertEquals([noSize.status, await noSize.text()], [400, "unsupported image type"]);
  // A real header over a corrupt payload: libavif refuses it, and the error is a 400.
  const corrupt = file.slice();
  corrupt.fill(0, corrupt.length - 20);
  const { value: failed } = await quietly(() => transformImageBytes(corrupt, { width: 32 }));
  assertEquals([failed.status, await failed.text()], [400, "image transform failed"]);
});

/** Run `fn` with `console.error` silenced (the expected failure logs). */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T }> {
  const { error } = console;
  console.error = () => {};
  try {
    return { value: await fn() };
  } finally {
    console.error = error;
  }
}
