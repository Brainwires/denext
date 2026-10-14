// @denext/backend storage, unit level: key normalization (no traversal), content-type matching
// and magic-byte sniffing, HMAC URL signing (tamper, expiry, rotation), upload grants, the sign
// route's schema, the transform query codec and the stream helpers.

import { assert, assertEquals, assertFalse, assertRejects, assertThrows } from "@std/assert";
import { checkBucketName, normalizeKey, normalizePrefix } from "../packages/backend/src/keys.ts";
import { checkSniffed, essence, mimeAllowed, sniffMime } from "../packages/backend/src/mime.ts";
import {
  checkExpiry,
  fromBase64Url,
  nowSeconds,
  openGrant,
  resolveSecrets,
  sealGrant,
  signPayload,
  toBase64Url,
  verifyPayload,
} from "../packages/backend/src/signing.ts";
import { signSchema } from "../packages/backend/src/sign-schema.ts";
import { objectPath, readTransform, writeTransform } from "../packages/backend/src/shared.ts";
import { concat, limit, peek, readAll, toStream } from "../packages/backend/src/streams.ts";
import { isStorageError, StorageError } from "../packages/backend/src/errors.ts";
import {
  bucketOf,
  clampExpiry,
  installRuntime,
  runtime,
  secretsOf,
} from "../packages/backend/src/runtime.ts";
import { samplePng } from "./fixtures/sample-image.ts";

const SECRET = "s".repeat(32);

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return isStorageError(err) ? err.code : String(err);
  }
  return "ok";
}

Deno.test("keys: valid keys pass through (NFC-normalized)", () => {
  assertEquals(normalizeKey("a/b c/ü.png"), "a/b c/ü.png");
  assertEquals(normalizeKey("café"), "café");
  assertEquals(normalizeKey("..a/b..c/.hidden"), "..a/b..c/.hidden");
});

Deno.test("keys: traversal, empty segments, controls and backslashes are refused", () => {
  for (
    const bad of [
      "",
      "/a",
      "a/",
      "a//b",
      ".",
      "..",
      "a/../b",
      "a/./b",
      "../etc/passwd",
      "a\\b",
      "a\0b",
      "a\nb",
      "x".repeat(1025),
    ]
  ) {
    assertEquals(code(() => normalizeKey(bad)), "invalid_key", JSON.stringify(bad));
  }
  assertEquals(code(() => normalizeKey(42 as unknown as string)), "invalid_key");
  // A key whose NFC form is a traversal is refused too (the normalized form is what's checked).
  assertEquals(code(() => normalizeKey("a/..")), "invalid_key");
  assertEquals(code(() => normalizeKey("é".repeat(513))), "invalid_key"); // 1026 UTF-8 bytes
});

Deno.test("keys: prefixes and bucket names", () => {
  assertEquals(normalizePrefix(""), "");
  assertEquals(normalizePrefix("photos/"), "photos/");
  assertEquals(normalizePrefix("photos/2026"), "photos/2026");
  assertEquals(code(() => normalizePrefix("../")), "invalid_key");
  assertEquals(code(() => normalizePrefix(1 as unknown as string)), "invalid_key");
  assertEquals(checkBucketName("avatars_2-x"), "avatars_2-x");
  for (const bad of ["", "Avatars", "-x", ".meta", "a/b", "x".repeat(64)]) {
    assertEquals(code(() => checkBucketName(bad)), "invalid_bucket", bad);
  }
});

Deno.test("mime: essence and allow-list matching", () => {
  assertEquals(essence("Image/PNG; charset=x"), "image/png");
  assertEquals(essence("not a type"), "");
  assert(mimeAllowed("image/png", undefined));
  assert(mimeAllowed("image/png", ["image/*"]));
  assert(mimeAllowed("application/pdf", ["image/*", "Application/PDF"]));
  assert(mimeAllowed("text/plain", ["*/*"]));
  assertFalse(mimeAllowed("text/html", ["image/*", "application/pdf"]));
  assertFalse(mimeAllowed("imagex/png", ["image/*"]));
});

Deno.test("mime: magic-byte sniffing recognizes the raster formats", () => {
  const b = (...xs: number[]) => new Uint8Array(xs);
  const s = (text: string) => new TextEncoder().encode(text);
  assertEquals(sniffMime(samplePng()), "image/png");
  assertEquals(sniffMime(b(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assertEquals(sniffMime(s("GIF89a....")), "image/gif");
  assertEquals(sniffMime(s("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assertEquals(sniffMime(s("\0\0\0\x1cftypavif")), "image/avif");
  assertEquals(sniffMime(s("\0\0\0\x18ftypheic")), "image/heic");
  assertEquals(sniffMime(s("BM......")), "image/bmp");
  assertEquals(sniffMime(b(0, 0, 1, 0, 1)), "image/x-icon");
  assertEquals(sniffMime(b(0x49, 0x49, 0x2a, 0)), "image/tiff");
  assertEquals(sniffMime(s("<html><script>")), null);
  assertEquals(sniffMime(new Uint8Array()), null);
});

Deno.test("mime: checkSniffed refuses content that contradicts its declared type", () => {
  const html = new TextEncoder().encode("<html><script>alert(1)</script>");
  assertEquals(code(() => checkSniffed("image/png", html)), "mime_mismatch");
  assertEquals(code(() => checkSniffed("image/jpeg", samplePng())), "mime_mismatch");
  assertEquals(code(() => checkSniffed("image/png", samplePng())), "ok");
  assertEquals(code(() => checkSniffed("image/jpg", new Uint8Array([0xff, 0xd8, 0xff]))), "ok");
  assertEquals(
    code(() => checkSniffed("image/svg+xml", new TextEncoder().encode("﻿  <svg xmlns"))),
    "ok",
  );
  assertEquals(code(() => checkSniffed("image/svg+xml", html)), "mime_mismatch");
  // Undetectable declared types are not sniffed…
  assertEquals(code(() => checkSniffed("text/plain", html)), "ok");
  assertEquals(code(() => checkSniffed("image/jxl", html)), "ok");
  // …but image content outside the allow-list is refused whatever it claims to be.
  assertEquals(
    code(() => checkSniffed("application/pdf", samplePng(), ["application/pdf"])),
    "mime_mismatch",
  );
  assertEquals(
    code(() => checkSniffed("application/pdf", samplePng(), ["application/pdf", "image/*"])),
    "ok",
  );
});

Deno.test("signing: a signature verifies, and any change to payload or signature fails", async () => {
  const sig = await signPayload("GET\nb\nk\n123\n", [SECRET]);
  assert(await verifyPayload("GET\nb\nk\n123\n", sig, [SECRET]));
  assertFalse(await verifyPayload("GET\nb\nk2\n123\n", sig, [SECRET]));
  assertFalse(await verifyPayload("GET\nb\nk\n123\n", sig, ["t".repeat(32)]));
  const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  assertFalse(await verifyPayload("GET\nb\nk\n123\n", flipped, [SECRET]));
  assertFalse(await verifyPayload("GET\nb\nk\n123\n", sig.slice(0, -2), [SECRET]));
  assertFalse(await verifyPayload("GET\nb\nk\n123\n", "!!!", [SECRET]));
  assertFalse(await verifyPayload("GET\nb\nk\n123\n", "", [SECRET]));
});

Deno.test("signing: a rotated-out secret still verifies while it is listed", async () => {
  const old = "o".repeat(40);
  const sig = await signPayload("p", [old]);
  assert(await verifyPayload("p", sig, [SECRET, old]));
  assertFalse(await verifyPayload("p", sig, [SECRET]));
});

Deno.test("signing: base64url round-trips and rejects junk", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(33));
  assertEquals(fromBase64Url(toBase64Url(bytes)), bytes);
  assertEquals(fromBase64Url("a+b"), null);
  assertEquals(fromBase64Url("a"), null);
});

Deno.test("signing: expiry must be a future integer", () => {
  assertEquals(code(() => checkExpiry(null)), "bad_signature");
  assertEquals(code(() => checkExpiry("12.5")), "bad_signature");
  assertEquals(code(() => checkExpiry(String(nowSeconds() - 1))), "expired");
  assertEquals(checkExpiry(String(nowSeconds() + 60)), nowSeconds() + 60);
});

Deno.test("signing: secrets resolve from config, then env, then a random dev secret", () => {
  const noEnv = () => undefined;
  assertEquals(resolveSecrets(SECRET, noEnv, false), [SECRET]);
  assertEquals(resolveSecrets([SECRET, "o".repeat(32)], noEnv, false), [SECRET, "o".repeat(32)]);
  assertEquals(resolveSecrets(undefined, () => SECRET, false), [SECRET]);
  assertEquals(resolveSecrets(undefined, noEnv, false), null);
  const dev = resolveSecrets(undefined, noEnv, true)!;
  assertEquals(dev.length, 1);
  assert(dev[0].length >= 32);
  assertEquals(code(() => resolveSecrets("short", noEnv, false)), "not_configured");
});

Deno.test("signing: upload grants round-trip, and a tampered or expired one is refused", async () => {
  const grant = {
    b: "docs",
    k: "a.txt",
    ct: "text/plain",
    max: 10,
    v: crypto.randomUUID(),
    exp: nowSeconds() + 60,
  };
  const token = await sealGrant(grant, [SECRET]);
  assertEquals(await openGrant(token, [SECRET]), grant);
  const [body, sig] = token.split(".");
  const forged = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...grant, max: 1e12 })));
  await assertRejects(() => openGrant(`${forged}.${sig}`, [SECRET]), StorageError, "signature");
  await assertRejects(() => openGrant(`${body}.${sig}.x`, [SECRET]), StorageError, "malformed");
  await assertRejects(() => openGrant(42, [SECRET]), StorageError, "malformed");
  const expired = await sealGrant({ ...grant, exp: nowSeconds() - 1 }, [SECRET]);
  await assertRejects(() => openGrant(expired, [SECRET]), StorageError, "expired");
});

Deno.test("sign schema: accepts each op and reports every bad field", () => {
  const v = (x: unknown) =>
    signSchema["~standard"].validate(x) as { value?: unknown; issues?: { path: unknown[] }[] };
  assert(v({ op: "upload", bucket: "b", contentType: "image/png", size: 3 }).value);
  assert(v({ op: "complete", token: "t", parts: [{ partNumber: 1, etag: "e" }] }).value);
  assert(v({ op: "abort", token: "t" }).value);
  assert(
    v({ op: "download", bucket: "b", key: "k", transform: { width: 64, format: "webp" } }).value,
  );
  assertEquals(v("x").issues?.length, 1);
  assertEquals(v({ op: "nope" }).issues?.[0].path, ["op"]);
  assertEquals(v({ op: "toString" }).issues?.[0].path, ["op"]);
  const bad = v({ op: "upload", bucket: 1, contentType: "x", size: -1, extra: true }).issues!;
  assertEquals(bad.map((i) => i.path[0]).sort(), ["bucket", "extra", "size"]);
  assertEquals(v({ op: "complete", token: "t", parts: [{ partNumber: "1" }] }).issues?.[0].path, [
    "parts",
  ]);
  assertEquals(
    v({ op: "download", bucket: "b", key: "k", transform: { width: 1, evil: 1 } }).issues?.[0].path,
    ["transform"],
  );
  assertEquals(
    v({ op: "download", bucket: "b", key: "k", transform: { format: "gif" } }).issues?.[0].path,
    ["transform"],
  );
  assertEquals(v({ op: "download", bucket: "b", key: "k", expiresIn: 0 }).issues?.[0].path, [
    "expiresIn",
  ]);
});

Deno.test("shared: transforms round-trip through the query; object paths encode each segment", () => {
  const params = new URLSearchParams();
  writeTransform(params, { width: 64, height: 32, quality: 80, format: "avif" });
  assertEquals(params.toString(), "w=64&h=32&q=80&fmt=avif");
  assertEquals(readTransform(params), { width: 64, height: 32, quality: 80, format: "avif" });
  assertEquals(readTransform(new URLSearchParams("w=0x10")), { width: NaN });
  assertEquals(readTransform(new URLSearchParams("a=1")), undefined);
  writeTransform(params, undefined);
  assertEquals(objectPath("/base", "b", "a b/c?d#e"), "/base/_denext/storage/o/b/a%20b/c%3Fd%23e");
});

Deno.test("streams: toStream, peek keeps every byte, limit caps and checks the exact size", async () => {
  const text = await new Response(toStream("hello").stream).text();
  assertEquals(text, "hello");
  assertEquals(toStream(new Uint8Array(3)).size, 3);
  assertEquals(toStream(new ArrayBuffer(4)).size, 4);
  assertEquals(toStream(new Blob(["abcd"])).size, 4);
  assertEquals(toStream(new Blob(["abcd"]).stream()).size, undefined);
  assertEquals(await new Response(toStream("").stream).text(), "");

  const chunks = ["ab", "cd", "ef"].map((s) => new TextEncoder().encode(s));
  const source = new ReadableStream({
    start: (c) => (chunks.forEach((x) => c.enqueue(x)), c.close()),
  });
  const { head, stream } = await peek(source, 3);
  assertEquals(new TextDecoder().decode(head), "abc");
  assertEquals(await new Response(stream).text(), "abcdef");
  const short = await peek(toStream("a").stream, 64);
  assertEquals(short.head.byteLength, 1);
  assertEquals(await new Response(short.stream).text(), "a");

  await assertRejects(() => readAll(toStream("toolong").stream, 3), StorageError, "exceeds");
  await assertRejects(
    () => new Response(limit(toStream("abc").stream, 10, 4)).text(),
    StorageError,
    "declared",
  );
  assertEquals(await readAll(toStream("abc").stream, 3), new TextEncoder().encode("abc"));
  assertEquals(concat([], 0).byteLength, 0);
  const cancelled = await peek(toStream("xyz").stream, 1);
  await cancelled.stream.cancel();
});

Deno.test("runtime: unconfigured storage, unknown buckets, missing secrets, expiry clamp", () => {
  installRuntime(undefined);
  assertEquals(code(() => runtime()), "not_configured");
  const rt = {
    driver: {} as never,
    buckets: new Map([["a", { name: "a", maxBytes: 1 }]]),
    secrets: null,
    basePath: "",
    multipartThreshold: 1,
    partSize: 1,
    meta: {} as never,
    rls: false,
    apiBase: null,
    maxTransformDimension: 2500,
  };
  assertEquals(code(() => bucketOf(rt, "b")), "unknown_bucket");
  assertEquals(code(() => bucketOf(rt, 1 as unknown as string)), "unknown_bucket");
  assertEquals(code(() => secretsOf(rt)), "not_configured");
  assertEquals(clampExpiry(undefined, 60), 60);
  assertEquals(clampExpiry(1e9, 60), 7 * 24 * 3600);
  assertThrows(() => clampExpiry(0, 60), StorageError);
  assertThrows(() => clampExpiry(NaN, 60), StorageError);
  assertEquals(new StorageError("forbidden", "x").status, 403);
});
