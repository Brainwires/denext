// Where `@denext/auth` lives relative to the running framework, and the `next-auth` subpaths it
// exports. The auth layer is its own package from denext 5.0, versioned with denext (auth X.Y.Z
// pins denext X.Y.Z exactly), so it sits beside the framework in either scheme: the workspace
// member `packages/auth/` of a checkout, or `@denext/auth/<same version>/` next to
// `@denext/denext/<version>/` on JSR.

import { fromFileUrl, join } from "@std/path";
import { frameworkRootUrl } from "./framework-root.ts";
import { NEXT_AUTH_PROVIDER_MODULES } from "./next-auth-providers.ts";

/** The JSR package name of the auth layer. */
const AUTH_PACKAGE = "@denext/auth";

/** A JSR package root URL: `…/@denext/denext/<version>/`. */
const JSR_DENEXT_ROOT = /^(.*\/)@denext\/denext\/([^/]+)\/$/;

/**
 * The `@denext/auth` package root for a framework root URL, ending with a slash: the JSR
 * sibling at the same version (`https://jsr.io/@denext/auth/5.0.0/` beside
 * `https://jsr.io/@denext/denext/5.0.0/`), else the workspace member `packages/auth/`.
 *
 * @param frameworkBase The framework root URL (default: the running framework's).
 * @returns The auth package root URL.
 */
export function authPackageRootUrl(frameworkBase: string = frameworkRootUrl()): string {
  const base = frameworkBase.endsWith("/") ? frameworkBase : frameworkBase + "/";
  const jsr = JSR_DENEXT_ROOT.exec(base);
  if (jsr) return `${jsr[1]}@denext/auth/${jsr[2]}/`;
  return new URL("packages/auth/", base).href;
}

/**
 * The `next-auth` specifiers `@denext/auth` provides (`next-auth`, `next-auth/react`, …, one per
 * provider module), in its `deno.json` `exports` order. A constant, so `denext migrate` knows
 * them without reading the package (a compiled CLI carries only the framework's own `deno.json`);
 * a test keeps it equal to the package's exports.
 */
export const NEXT_AUTH_SUBPATHS: readonly string[] = [
  "next-auth",
  "next-auth/react",
  "next-auth/webauthn",
  "next-auth/jwt",
  "next-auth/next",
  "next-auth/middleware",
  "next-auth/adapters",
  "next-auth/providers",
  ...NEXT_AUTH_PROVIDER_MODULES.map((p) => `next-auth/providers/${p}`),
];

/**
 * `@denext/auth`'s `deno.json` `exports`, read from {@link authPackageRootUrl} (a file read for
 * a checkout, a fetch from JSR otherwise).
 *
 * @param frameworkBase The framework root URL (default: the running framework's).
 * @returns The exports map (`"./next-auth/jwt"` → `"./next-auth/jwt.ts"`).
 */
export async function authPackageExports(
  frameworkBase: string = frameworkRootUrl(),
): Promise<Record<string, string>> {
  const url = new URL("deno.json", authPackageRootUrl(frameworkBase)).href;
  let text: string;
  try {
    if (url.startsWith("file://")) text = await Deno.readTextFile(fromFileUrl(url));
    else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      text = await res.text();
    }
  } catch (err) {
    throw new Error(
      `denext: could not read ${AUTH_PACKAGE}'s deno.json (${url}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  return ((JSON.parse(text) as { exports?: Record<string, string> }).exports ?? {});
}

/**
 * The module URL a `denext/auth` or `denext/next-auth[/…]` specifier names in `@denext/auth`
 * (`denext/next-auth/jwt` → `…/@denext/auth/<v>/next-auth/jwt.ts`), or `undefined` for any
 * other specifier.
 *
 * @param spec The specifier.
 * @param exportsMap `@denext/auth`'s exports ({@link authPackageExports}).
 * @param frameworkBase The framework root URL.
 * @returns The URL, or `undefined`.
 */
export function authModuleUrl(
  spec: string,
  exportsMap: Readonly<Record<string, string>>,
  frameworkBase: string = frameworkRootUrl(),
): string | undefined {
  const key = spec === "denext/auth"
    ? "."
    : spec === "denext/next-auth" || spec.startsWith("denext/next-auth/")
    ? "./" + spec.slice("denext/".length)
    : undefined;
  const rel = key === undefined ? undefined : exportsMap[key];
  return rel ? new URL(rel, authPackageRootUrl(frameworkBase)).href : undefined;
}

/**
 * Whether the app in `dir` uses `next-auth`: its `deno.json` / `deno.jsonc` import map maps
 * `next-auth` (what `denext migrate` writes), or its `package.json` depends on it. The compat
 * runtime prebuilds the `next-auth` client modules only then, so an app without it never loads
 * `@denext/auth`.
 *
 * @param dir The project directory.
 * @returns `true` when the app uses `next-auth`.
 */
export async function usesNextAuth(dir: string): Promise<boolean> {
  const read = (name: string) => Deno.readTextFile(join(dir, name)).catch(() => "");
  const mentions = (text: string) => /"next-auth(?:\/[^"]*)?"\s*:/.test(text);
  for (const name of ["deno.json", "deno.jsonc", "package.json"]) {
    if (mentions(await read(name))) return true;
  }
  return false;
}
