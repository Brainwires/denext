// Next.js-compat entrypoints: `import ... from "next/*"` resolving to denext.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { composeMiddleware } from "../src/server/middleware.ts";
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

// ---- NextResponse full matrix + middleware-runner integration -------------
//
// NextResponse.next()/.rewrite() are real Responses encoding Next's x-middleware-*
// wire protocol; the denext middleware runner must decode them. These tests drive a
// NextResponse THROUGH composeMiddleware, closing the gap between the compat layer
// that produces the headers and the runner that consumes them.

Deno.test("NextResponse.next() flows through the runner as a 'next' outcome", async () => {
  const run = composeMiddleware([{
    handler: () => NextResponse.next({ headers: { "x-a": "1" } }),
  }])!;
  const outcome = await run(new Request("http://localhost/x"));
  assertEquals(outcome.type, "next");
  if (outcome.type === "next") assertEquals(outcome.headers?.get("x-a"), "1");
});

Deno.test("NextResponse.rewrite() flows through the runner as a 'rewrite' outcome", async () => {
  const run = composeMiddleware([{ handler: () => NextResponse.rewrite("/dest") }])!;
  const outcome = await run(new Request("http://localhost/from"));
  assertEquals(outcome.type, "rewrite");
  if (outcome.type === "rewrite") assertEquals(outcome.url, "http://localhost/dest");
});

Deno.test("NextResponse.next({request:{headers}}) overrides the forwarded request headers", async () => {
  let seen: string | null = "unset";
  const run = composeMiddleware([
    {
      handler: () => NextResponse.next({ request: { headers: new Headers({ "x-user": "bob" }) } }),
    },
    {
      handler: (req) => {
        seen = req.headers.get("x-user");
        return NextResponse.next();
      },
    },
  ])!;
  await run(new Request("http://localhost/x"));
  assertEquals(seen, "bob", "the request-header override reaches the next entry");
});

Deno.test("NextResponse.redirect defaults to 307 and honors a custom status", () => {
  assertEquals(NextResponse.redirect("https://x.test/a").status, 307, "default 307");
  assertEquals(NextResponse.redirect("https://x.test/a", 308).status, 308, "numeric status");
  assertEquals(
    NextResponse.redirect("https://x.test/a", { status: 301 }).status,
    301,
    "ResponseInit status",
  );
});

Deno.test("NextResponse.redirect throws on a relative URL (Next parity)", () => {
  assertThrows(() => NextResponse.redirect("/relative"), TypeError);
});

Deno.test("NextResponse.json sets content-type, stringifies, and honors a custom status", async () => {
  const res = NextResponse.json({ ok: true }, { status: 201 });
  assertEquals(res.status, 201);
  assert((res.headers.get("content-type") ?? "").includes("application/json"));
  assertEquals(await res.json(), { ok: true });
});

Deno.test("NextResponse.cookies writes a Set-Cookie onto the response", () => {
  const res = NextResponse.next();
  res.cookies.set("seen", "1");
  const sc = res.headers.get("set-cookie") ?? "";
  assert(sc.includes("seen=1"), `expected a seen cookie: ${sc}`);
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

// The SSR bundle server-renders the "use client" tree as well (it is not a `react-server`
// layer), and libraries such as react-aria-components import `client-only` from modules
// that legitimately SSR — so `client-only` never fails a bundle on either side.
Deno.test("checkEnvPoison: client-only is inert in both bundles", async () => {
  const { checkEnvPoison } = await import("../src/build/next-compat.ts");
  assertEquals(checkEnvPoison("client-only", true), null);
  assertEquals(checkEnvPoison("client-only", false), null);
});

// The Flight entry imports islands by file URL; an npm package's own "use client" module
// (next-themes, nuqs, vaul) lives under node_modules, where the deno-loader declines file
// URLs — the compat chain maps those to plain paths so the island bundles.
Deno.test({
  name: "nodeModulesFileUrlPlugin: a file:// island inside node_modules bundles",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { nodeModulesFileUrlPlugin } = await import("../src/build/next-compat.ts");
  const esbuild = await import("esbuild");
  const { join, toFileUrl } = await import("@std/path");
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_nm_island_" }));
  try {
    const pkg = join(root, "node_modules", "themer", "dist");
    await Deno.mkdir(pkg, { recursive: true });
    await Deno.writeTextFile(
      join(pkg, "index.mjs"),
      `"use client";\nexport const THEME = "nm-island-ok";`,
    );
    const out = await esbuild.build({
      stdin: {
        contents: `import * as M from ${
          JSON.stringify(toFileUrl(join(pkg, "index.mjs")).href)
        };\nexport const t = M.THEME;`,
        loader: "js",
        resolveDir: root,
      },
      bundle: true,
      write: false,
      format: "esm",
      plugins: [nodeModulesFileUrlPlugin()],
      logLevel: "silent",
    });
    assert(out.outputFiles[0].text.includes("nm-island-ok"));
  } finally {
    await esbuild.stop();
    await Deno.remove(root, { recursive: true });
  }
});

// CJS packages read `__filename`/`__dirname` at module init; esbuild leaves them unbound in
// ESM output, so the SSR bundle injects a per-chunk shim (esbuild's own JS API, pulled in by
// a docs tool, threw "ReferenceError: __filename is not defined" on shadcn/ui's first render).
Deno.test({
  name: "nodeGlobalsShimPath: an injected shim binds __filename/__dirname in an ESM bundle",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { nodeGlobalsShimPath } = await import("../src/build/next-compat.ts");
  const esbuild = await import("esbuild");
  const { join, toFileUrl } = await import("@std/path");
  const dir = await Deno.makeTempDir({ prefix: "denext_node_globals_" });
  try {
    const out = await esbuild.build({
      stdin: {
        contents: `export const here = __filename.endsWith(".js") ? __dirname : "";`,
        loader: "js",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      external: ["node:*"],
      inject: [await nodeGlobalsShimPath(dir)],
      logLevel: "silent",
    });
    const text = out.outputFiles[0].text;
    assert(text.includes("fileURLToPath(") && text.includes("import.meta.url"), "shim bundled in");
    // It runs: the module evaluates without a ReferenceError.
    const outFile = join(dir, "out.js");
    await Deno.writeTextFile(outFile, text);
    const mod = await import(toFileUrl(outFile).href);
    assertEquals(typeof mod.here, "string");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

// Node-ESM libraries (fumadocs, nuqs) import `next/navigation.js` — the alias lookup must see
// `next/navigation`, or the real Next router lands in the bundle ("invariant expected app router
// to be mounted" on shadcn/ui's first render).
Deno.test("normalizeNextSpecifier drops Node's explicit .js extension, leaves deep paths alone", async () => {
  const { normalizeNextSpecifier, NEXT_ALIASES } = await import("../src/build/next-compat.ts");
  assertEquals(normalizeNextSpecifier("next/navigation.js"), "next/navigation");
  assertEquals(normalizeNextSpecifier("next/font/google.js"), "next/font/google");
  assertEquals(normalizeNextSpecifier("next/link.mjs"), "next/link");
  assertEquals(normalizeNextSpecifier("next/navigation"), "next/navigation");
  assertEquals(normalizeNextSpecifier("next"), "next");
  assertEquals(
    normalizeNextSpecifier("next/dist/shared/lib/get-img-props.js"),
    "next/dist/shared/lib/get-img-props",
  );
  assert(NEXT_ALIASES[normalizeNextSpecifier("next/navigation.js")]);
  assert(NEXT_ALIASES[normalizeNextSpecifier("next/server.js")]);
});

// Browser bundles: npm libraries read `process.env.DEBUG`/`NODE_ENV` at module init and a migrated
// app reads `process.env.NEXT_PUBLIC_*` — shadcn/ui's first chunk threw "process is not defined".
Deno.test({
  name: "browserProcessShimPath: an injected process shim serves env reads in a browser bundle",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { browserProcessShimPath } = await import("../src/build/next-compat.ts");
  const esbuild = await import("esbuild");
  const { join, toFileUrl } = await import("@std/path");
  const dir = await Deno.makeTempDir({ prefix: "denext_browser_process_" });
  try {
    const out = await esbuild.build({
      stdin: {
        contents: `export const mode = process.env.NODE_ENV; export const dbg = process.env.DEBUG;
export const pub = process.env.NEXT_PUBLIC_APP_URL; export const isBrowser = process.browser;`,
        loader: "js",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      minify: true, // esbuild's own NODE_ENV define ("development" unminified) must agree
      inject: [await browserProcessShimPath(dir, "production")],
      logLevel: "silent",
    });
    const outFile = join(dir, "out.js");
    await Deno.writeTextFile(outFile, out.outputFiles[0].text);
    const mod = await import(toFileUrl(outFile).href); // no `document` here → island absent
    assertEquals(mod.mode, "production");
    assertEquals(mod.dbg, undefined);
    assertEquals(mod.pub, undefined);
    assertEquals(mod.isBrowser, true);
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

// `cacheComponents`: the "use cache" transform runs INSIDE the compat bundle. The runtime
// loader's rewritten copy (`.denext/server-cache/uc_*.tsx`) is imported natively and, for a
// compat app, its `next/*` and `.mdx` imports fail under Deno — every cacheComponents route of
// the Next App Router playground 500'd.
Deno.test({
  name:
    'cacheDirectivePlugin: a module with "use cache" is transformed in the bundle; others fall through',
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { cacheDirectivePlugin } = await import("../src/build/next-compat.ts");
  const esbuild = await import("esbuild");
  const { join } = await import("@std/path");
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_use_cache_plugin_" }));
  try {
    await Deno.writeTextFile(
      join(dir, "data.ts"),
      `export async function getPosts(tag: string) { "use cache"; return [tag]; }\n`,
    );
    await Deno.writeTextFile(join(dir, "plain.ts"), `export const plain = "PLAIN_OK";\n`);
    await Deno.writeTextFile(
      join(dir, "entry.ts"),
      `export { getPosts } from "./data.ts";\nexport { plain } from "./plain.ts";\n`,
    );
    const out = await esbuild.build({
      entryPoints: [join(dir, "entry.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      packages: "external",
      plugins: [cacheDirectivePlugin()],
      logLevel: "silent",
    });
    const text = out.outputFiles[0].text;
    assertStringIncludes(text, "_dnxUseCache(", "the cached function is wrapped in the bundle");
    assertStringIncludes(text, "PLAIN_OK", "modules without the directive bundle normally");
  } finally {
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

// A build-time transform's runtime import is an absolute URL into the framework (the
// "use cache" wrapper imports `src/server/cache.ts`); the SSR bundle must leave it external —
// bundling it fails on the framework's `@std/*` deps and would double the runtime.
Deno.test({
  name: "SSR bundle: an absolute import into the framework stays external",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { bundleNextCompatModules } = await import("../src/build/next-compat.ts");
  const { frameworkFileUrl } = await import("../src/build/bundle.ts");
  const { join } = await import("@std/path");
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_fw_external_" }));
  try {
    const runtime = frameworkFileUrl("src/server/cache.ts");
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { "denext/": frameworkFileUrl("") } }),
    );
    await Deno.writeTextFile(
      join(dir, "entry.ts"),
      `import { __useCache } from ${
        JSON.stringify(runtime)
      };\nexport const k = typeof __useCache;\n`,
    );
    await bundleNextCompatModules({
      entryPoints: { app: join(dir, "entry.ts") },
      outdir: join(dir, "out"),
      configPath: join(dir, "deno.json"),
      platform: "deno",
      denextExternal: true,
      denoLoader: false,
      absWorkingDir: dir,
    });
    const out = await Deno.readTextFile(join(dir, "out", "app.js"));
    assertStringIncludes(out, `from "${runtime}"`, "framework URL kept as an external import");
  } finally {
    const esbuild = await import("esbuild");
    await esbuild.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
