// What `denext migrate` learns about an app's `next-auth`: which major it is written for (Auth.js
// v5, or NextAuth.js v4), which v4 server APIs its source uses — `NextAuth(authOptions)` route
// handlers, `getServerSession`, `next-auth/next`, `next-auth/middleware` — and which Auth.js
// adapters back it. Every one of them resolves to denext's `next-auth` shim through the aliases
// migrate writes (and an adapter from the app's own dependencies), so no source changes; this
// report says what was recognised and what to check.

import { join } from "@std/path";
import { projectSourceFiles } from "./platform-extensions.ts";

/** The `next-auth` report of a migration. */
export interface NextAuthMigrateInfo {
  /** The major the app depends on: NextAuth.js v4 or Auth.js v5. */
  version: "v4" | "v5";
  /** The v4 server APIs the source uses, each served by the shim. */
  v4Apis: string[];
  /** The Auth.js adapters (`@auth/*-adapter`, `@next-auth/*-adapter`) the app depends on. */
  adapters: string[];
  /** What to check by hand. */
  notes: string[];
}

/**
 * The major a `next-auth` range installs: `4.x` ranges (and the `latest` dist-tag, still v4) are
 * v4; `5.x` and `beta` are v5.
 *
 * @param range The dependency's range (`^4.24.11`, `5.0.0-beta.29`, `beta`, `latest`).
 * @returns `"v4"` or `"v5"`.
 */
export function nextAuthMajor(range: string): "v4" | "v5" {
  const spec = range.trim().replace(/^npm:next-auth@/, "");
  if (/beta|^[\^~>=v\s]*5/.test(spec)) return "v5";
  return "v4";
}

/** The v4 server APIs, by the source text that uses them. */
const V4_API_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["next-auth/next", /["']next-auth\/next["']/],
  ["getServerSession", /\b(?:unstable_)?getServerSession\s*\(/],
  ["next-auth/middleware", /["']next-auth\/middleware["']/],
  ["next-auth/adapters", /["']next-auth\/adapters["']/],
];

/** A Pages Router `[...nextauth]` API route, relative to the project. */
async function pagesAuthRoute(dir: string): Promise<string | null> {
  for (const root of ["pages", "src/pages"]) {
    for (const ext of ["ts", "js", "tsx", "jsx"]) {
      const rel = `${root}/api/auth/[...nextauth].${ext}`;
      try {
        if ((await Deno.stat(join(dir, rel))).isFile) return rel;
      } catch { /* absent */ }
    }
  }
  return null;
}

/** The v4 APIs the app's own source uses. */
async function v4ApisIn(dir: string): Promise<string[]> {
  const found = new Set<string>();
  for await (const file of projectSourceFiles(dir)) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    if (!text.includes("next-auth") && !text.includes("getServerSession")) continue;
    for (const [api, pattern] of V4_API_PATTERNS) if (pattern.test(text)) found.add(api);
  }
  return V4_API_PATTERNS.map(([api]) => api).filter((api) => found.has(api));
}

/**
 * The `next-auth` report for the app in `dir`, or `undefined` when it doesn't depend on
 * `next-auth`.
 *
 * @param dir The project directory.
 * @param deps Its dependencies (`package.json`'s, dev ones included).
 * @param pagesRouter Whether migrate wired the Pages Router plugin.
 * @returns The report.
 */
export async function nextAuthMigrateInfo(
  dir: string,
  deps: Record<string, string>,
  pagesRouter: boolean,
): Promise<NextAuthMigrateInfo | undefined> {
  const range = deps["next-auth"];
  if (range === undefined) return undefined;
  const version = nextAuthMajor(range);
  const v4Apis = await v4ApisIn(dir);
  const route = await pagesAuthRoute(dir);
  if (route) v4Apis.unshift(route);
  const adapters = Object.keys(deps).filter((d) => /^@(?:auth|next-auth)\/[\w.-]+-adapter$/.test(d))
    .sort();
  const notes = [
    `set ${
      version === "v4" ? "NEXTAUTH_URL" : "AUTH_URL"
    } in production: denext never derives the OAuth redirect_uri or its origin checks from ` +
    "the Host header",
  ];
  if (route && !pagesRouter) {
    notes.push(`${route} needs the @denext/pages-router plugin in denext.config.ts`);
  }
  if (v4Apis.includes("next-auth/middleware")) {
    notes.push(
      "next-auth/middleware reads the JWT session's token, as in v4: with " +
        '`session: { strategy: "database" }` every gated request is sent to sign in',
    );
  }
  return { version, v4Apis, adapters, notes };
}
