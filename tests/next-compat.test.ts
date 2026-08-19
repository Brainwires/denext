// Next.js-compat entrypoints: `import ... from "next/*"` resolving to denext.

import { assert, assertEquals } from "@std/assert";
import Link from "../src/compat/next/link.ts";
import Image from "../src/compat/next/image.ts";
import Script from "../src/compat/next/script.ts";
import dynamicDefault from "../src/compat/next/dynamic.ts";
import * as navigation from "../src/compat/next/navigation.ts";
import * as headersMod from "../src/compat/next/headers.ts";
import * as cacheMod from "../src/compat/next/cache.ts";
import { ImageResponse as OgImageResponse } from "../src/compat/next/og.ts";
import { NextResponse, userAgent } from "../src/compat/next/server.ts";

import {
  dynamic,
  Image as DImage,
  Link as DLink,
  notFound,
  redirect,
  Script as DScript,
  useRouter,
} from "../mod.ts";
import {
  cookies,
  headers as denextHeaders,
  ImageResponse,
  revalidatePath,
  revalidateTag,
  unstable_cache,
  userAgent as denextUserAgent,
} from "../src/server/mod.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("next/link · image · script · dynamic default-export denext components", () => {
  assertEquals(Link, DLink);
  assertEquals(Image, DImage);
  assertEquals(Script, DScript);
  assertEquals(dynamicDefault, dynamic);
});

Deno.test("next/navigation re-exports the App Router hooks + control flow", () => {
  assertEquals(navigation.useRouter, useRouter);
  assertEquals(navigation.redirect, redirect);
  assertEquals(navigation.notFound, notFound);
  for (
    const k of ["usePathname", "useSearchParams", "useParams", "permanentRedirect", "forbidden"]
  ) {
    assertEquals(typeof (navigation as Any)[k], "function", `next/navigation.${k}`);
  }
});

Deno.test("next/headers and next/cache re-export the server runtime", () => {
  assertEquals(headersMod.cookies, cookies);
  assertEquals(headersMod.headers, denextHeaders);
  assertEquals(cacheMod.revalidatePath, revalidatePath);
  assertEquals(cacheMod.revalidateTag, revalidateTag);
  assertEquals(cacheMod.unstable_cache, unstable_cache);
});

Deno.test("next/og re-exports ImageResponse; next/server re-exports userAgent", () => {
  assertEquals(OgImageResponse, ImageResponse);
  assertEquals(userAgent, denextUserAgent);
});

Deno.test("next/server NextResponse maps to denext middleware returns", () => {
  const red = NextResponse.redirect("https://x.test/y", 302);
  assertEquals(red.status, 302);
  assertEquals(red.headers.get("location"), "https://x.test/y");

  const json = NextResponse.json({ ok: true });
  assert((json.headers.get("content-type") ?? "").includes("application/json"));

  // next()/rewrite() return denext middleware commands (truthy objects the
  // middleware runner understands).
  const cont = NextResponse.next();
  assert(cont && typeof cont === "object");
  const rw = NextResponse.rewrite("/dest");
  assert(rw && typeof rw === "object");
});

// Build-time: an unmapped react-family import must fail SAFE to denext's runtime
// (never resolve to real React), with a warning surfacing the gap.
Deno.test("resolveReactFamilyFile: mapped specifiers resolve directly", async () => {
  const { resolveReactFamilyFile } = await import("../src/build/next-compat.ts");
  assertEquals(resolveReactFamilyFile("react"), { file: "react.js" });
  assertEquals(resolveReactFamilyFile("react/jsx-runtime"), { file: "jsx-runtime.js" });
  assertEquals(resolveReactFamilyFile("react-dom/client"), { file: "react-dom-client.js" });
});

Deno.test("resolveReactFamilyFile: an unmapped subpath fails safe to the base runtime + warns", async () => {
  const { resolveReactFamilyFile } = await import("../src/build/next-compat.ts");
  const r1 = resolveReactFamilyFile("react/experimental");
  assertEquals(r1.file, "react.js");
  assert(r1.warning?.includes("unmapped") && r1.warning.includes("never real React"));
  const r2 = resolveReactFamilyFile("react-dom/static");
  assertEquals(r2.file, "react-dom.js"); // never resolves to the real react-dom
  assert(r2.warning);
});

// Build-time server-only/client-only poison (Next.js parity): the wrong-side import
// fails the build instead of silently shipping/running and erroring at runtime.
Deno.test("checkEnvPoison: server-only in a client bundle is a build error", async () => {
  const { checkEnvPoison } = await import("../src/build/next-compat.ts");
  const err = checkEnvPoison("server-only", false, "app/secrets.ts");
  assert(err?.includes("CLIENT bundle") && err.includes("app/secrets.ts"));
  // ...but allowed on the server side.
  assertEquals(checkEnvPoison("server-only", true), null);
});

Deno.test("checkEnvPoison: client-only in a server bundle is a build error", async () => {
  const { checkEnvPoison } = await import("../src/build/next-compat.ts");
  assert(checkEnvPoison("client-only", true)?.includes("SERVER bundle"));
  assertEquals(checkEnvPoison("client-only", false), null); // fine in the browser bundle
});
