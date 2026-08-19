// The migration codemod: rewrite next/* and react imports to native denext.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { rewriteSource, runCodemod } from "../src/build/codemod.ts";

Deno.test("rewrites react named imports to denext", () => {
  const r = rewriteSource(`import { useState, useEffect } from "react";`);
  assertEquals(r.code, `import { useState, useEffect } from "denext";`);
  assertEquals(r.rewrites[0], { from: "react", to: "denext" });
});

Deno.test("react-dom/client → denext/client", () => {
  const r = rewriteSource(`import { createRoot } from "react-dom/client";`);
  assertEquals(r.code, `import { createRoot } from "denext/client";`);
});

Deno.test("default React import becomes a namespace", () => {
  const r = rewriteSource(`import React from "react";`);
  assertEquals(r.code, `import * as React from "denext";`);
});

Deno.test("default React + named splits into two statements", () => {
  const r = rewriteSource(`import React, { useState } from "react";`);
  assertStringIncludes(r.code, `import * as React from "denext";`);
  assertStringIncludes(r.code, `import { useState } from "denext";`);
});

Deno.test("next/link default → named { Link }", () => {
  const r = rewriteSource(`import Link from "next/link";`);
  assertEquals(r.code, `import { Link } from "denext";`);
  assertEquals(r.rewrites[0].from, "next/link");
});

Deno.test("aliased next/image default → { Image as X }", () => {
  const r = rewriteSource(`import NextImage from "next/image";`);
  assertEquals(r.code, `import { Image as NextImage } from "denext";`);
});

Deno.test("next/image default + type named merges", () => {
  const r = rewriteSource(`import Image, { type ImageProps } from "next/image";`);
  assertEquals(r.code, `import { Image, type ImageProps } from "denext";`);
});

Deno.test("next/navigation → denext (whole surface)", () => {
  const r = rewriteSource(
    `import { useRouter, usePathname, redirect, notFound } from "next/navigation";`,
  );
  assertEquals(
    r.code,
    `import { useRouter, usePathname, redirect, notFound } from "denext";`,
  );
});

Deno.test("next/headers and next/cache → denext/server", () => {
  const r1 = rewriteSource(`import { cookies, headers } from "next/headers";`);
  assertEquals(r1.code, `import { cookies, headers } from "denext/server";`);
  const r2 = rewriteSource(`import { revalidateTag } from "next/cache";`);
  assertEquals(r2.code, `import { revalidateTag } from "denext/server";`);
});

Deno.test("next/font/google → denext/next/font/google", () => {
  const r = rewriteSource(`import { Inter } from "next/font/google";`);
  assertEquals(r.code, `import { Inter } from "denext/next/font/google";`);
});

Deno.test("multiline named imports are handled", () => {
  const src = `import {
  useState,
  useEffect,
} from "react";`;
  const r = rewriteSource(src);
  assertStringIncludes(r.code, `from "denext"`);
  assert(!r.code.includes(`"react"`));
});

Deno.test("type-only import keeps its type modifier", () => {
  const r = rewriteSource(`import type { Metadata } from "next";`);
  // "next" isn't in the rewrite map (bare next), so it's untouched.
  assertEquals(r.changed, false);
});

Deno.test("re-export from is rewritten", () => {
  const r = rewriteSource(`export { redirect } from "next/navigation";`);
  assertEquals(r.code, `export { redirect } from "denext";`);
});

Deno.test("Pages Router imports produce a warning, not a rewrite", () => {
  const r = rewriteSource(`import { useRouter } from "next/router";`);
  assertEquals(r.changed, false);
  assertEquals(r.warnings.length, 1);
  assertStringIncludes(r.warnings[0].message, "Pages Router");
});

// --- Pages Router mode ------------------------------------------------------

Deno.test("pages mode: next/router → @denext/pages-router/router (rewritten, no warning)", () => {
  const r = rewriteSource(`import { useRouter } from "next/router";`, { pagesRouter: true });
  assertEquals(r.code, `import { useRouter } from "@denext/pages-router/router";`);
  assertEquals(r.warnings.length, 0);
});

Deno.test("pages mode: next/head default import → @denext/pages-router/head", () => {
  const r = rewriteSource(`import Head from "next/head";`, { pagesRouter: true });
  assertEquals(r.code, `import Head from "@denext/pages-router/head";`);
});

Deno.test("pages mode: next/link default → { Link } from the plugin", () => {
  const r = rewriteSource(`import Link from "next/link";`, { pagesRouter: true });
  assertEquals(r.code, `import { Link } from "@denext/pages-router/link";`);
});

Deno.test("pages mode: next/document stays a (softened) warning", () => {
  const r = rewriteSource(`import Document from "next/document";`, { pagesRouter: true });
  assertEquals(r.changed, false);
  assertEquals(r.warnings.length, 1);
  assertStringIncludes(r.warnings[0].message, "@denext/pages-router");
});

Deno.test("runCodemod auto-detects a pages/ tree and applies Pages Router rewrites", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_codemod_pages_" });
  try {
    await Deno.mkdir(join(dir, "pages"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "pages", "index.tsx"),
      `import { useRouter } from "next/router";\nimport Head from "next/head";\nexport default function P() { return null; }\n`,
    );
    const report = await runCodemod(dir, { write: true });
    assertEquals(report.pagesRouter, true);
    const out = await Deno.readTextFile(join(dir, "pages", "index.tsx"));
    assertStringIncludes(out, `from "@denext/pages-router/router"`);
    assertStringIncludes(out, `from "@denext/pages-router/head"`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a string literal containing 'from' is not mistaken for an import", () => {
  const src = `const msg = "imported from react";\nimport { useState } from "react";`;
  const r = rewriteSource(src);
  assertStringIncludes(r.code, `const msg = "imported from react";`);
  assertStringIncludes(r.code, `from "denext"`);
});

Deno.test("dynamic import() is left alone", () => {
  const src = `const m = await import("react");`;
  const r = rewriteSource(src);
  assertEquals(r.changed, false);
});

Deno.test("unrelated imports are untouched", () => {
  const src = `import { z } from "zod";\nimport foo from "./foo.ts";`;
  const r = rewriteSource(src);
  assertEquals(r.changed, false);
  assertEquals(r.code, src);
});

Deno.test("runCodemod dry-run reports without writing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_codemod_" });
  try {
    await Deno.mkdir(join(dir, "app"), { recursive: true });
    const file = join(dir, "app", "page.tsx");
    const original = `import Link from "next/link";\nexport default () => <Link href="/">x</Link>;`;
    await Deno.writeTextFile(file, original);

    const dry = await runCodemod(dir);
    assertEquals(dry.wrote, false);
    assertEquals(dry.files.length, 1);
    assertEquals(await Deno.readTextFile(file), original, "dry run must not write");

    const applied = await runCodemod(dir, { write: true });
    assertEquals(applied.wrote, true);
    assertStringIncludes(await Deno.readTextFile(file), `import { Link } from "denext";`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runCodemod skips node_modules and .denext", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_codemod_skip_" });
  try {
    await Deno.mkdir(join(dir, "node_modules", "x"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "node_modules", "x", "index.js"),
      `import Link from "next/link";`,
    );
    const report = await runCodemod(dir, { write: true });
    assertEquals(report.files.length, 0, "node_modules must be skipped");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
