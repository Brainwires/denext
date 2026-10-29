// The deprecation notice for project code run on stock Deno: denext 5.0 drops stock Deno support
// (it requires denext's own Deno, the toolchain), so every path that still runs on stock Deno
// today says so ONCE per process tree, with the fix.
//
// The paths that call {@linkcode warnStockDeprecation}:
//
//   - `DENEXT_DENO=stock` (src/cli/self-exec.ts: a command that keeps the Deno that started it);
//   - `DENEXT_DESKTOP_RUNTIME=stock`, and `desktop run` / `dev` falling back to the stock Deno
//     Desktop runtime for a `deno` of another version (src/build/desktop-runtime.ts);
//   - the npm esbuild, the fallback for stock Deno and a missing toolchain
//     (src/build/esbuild/mod.ts);
//   - `createTestApp()` in a process that is not denext's Deno: a plain `deno test` / `deno task`
//     under stock Deno (src/testing/mod.ts).
//
// Once per process tree: the first notice sets {@linkcode STOCK_DEPRECATION_SHOWN_ENV} in this
// process's environment, which every child inherits, and a process that finds it set stays quiet.
// `DENEXT_NO_DEPRECATION_WARNINGS=1` hides it.

import { currentDenoIdentity, type DenoIdentity, isDenextDenoVersion } from "./deno-version.ts";

/** Set to `1` (or `true`) to hide denext's deprecation notices. */
export const NO_DEPRECATION_WARNINGS_ENV = "DENEXT_NO_DEPRECATION_WARNINGS";

/** Set once the notice was printed: the process and its children stay quiet. */
export const STOCK_DEPRECATION_SHOWN_ENV = "DENEXT_STOCK_DEPRECATION_SHOWN";

/** Which stock path is running (it picks the notice's cause and fix). */
export type StockDenoPath =
  | "deno-env"
  | "desktop-env"
  | "desktop-mismatch"
  | "esbuild"
  | "stock-process";

/** What {@linkcode warnStockDeprecation} touches (each defaults to the process). */
export interface StockDeprecationDeps {
  /** An environment variable (default `Deno.env.get`; `undefined` without env access). */
  readonly env?: (name: string) => string | undefined;
  /** Set one for this process and its children (default `Deno.env.set`). */
  readonly setEnv?: (name: string, value: string) => void;
  /** Print the notice (default `console.error`). */
  readonly warn?: (message: string) => void;
}

const CAUSE: Readonly<Record<StockDenoPath, string>> = {
  "deno-env": "DENEXT_DENO=stock runs this command on stock Deno",
  "desktop-env": "DENEXT_DESKTOP_RUNTIME=stock builds with the stock Deno Desktop runtime",
  "desktop-mismatch": "this window builds with the stock Deno Desktop runtime, because the " +
    "`deno` that runs `deno desktop` is not denext's Deno",
  "esbuild": "denext is building with the npm esbuild, its fallback for stock Deno",
  "stock-process": "this process runs project code on stock Deno (a plain `deno task` or " +
    "`deno test`)",
};

const FIX: Readonly<Record<StockDenoPath, string>> = {
  "deno-env": "unset DENEXT_DENO (`denext toolchain install` fetches denext's Deno ahead)",
  "desktop-env": "unset DENEXT_DESKTOP_RUNTIME (denext's pinned runtime downloads on first use)",
  "desktop-mismatch": "`denext toolchain install`, and unset DENEXT_DENO / DENO_BIN",
  "esbuild": "`denext toolchain install` (the toolchain carries a verified esbuild)",
  "stock-process": "run it with `denext task <name>` or `denext test`, on denext's Deno " +
    "(`denext toolchain install`)",
};

/**
 * The deprecation notice for one stock path.
 *
 * @param path The path that runs on stock Deno.
 * @returns The notice (two lines, `denext:`-prefixed).
 */
export function stockDeprecationNotice(path: StockDenoPath): string {
  return `denext: deprecated: ${CAUSE[path]}. denext 5.0 drops stock Deno support.\n` +
    `  Fix: ${FIX[path]}. ${NO_DEPRECATION_WARNINGS_ENV}=1 hides this notice.`;
}

const processEnv = (name: string): string | undefined => {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined; // no env permission
  }
};

const processSetEnv = (name: string, value: string): void => {
  try {
    Deno.env.set(name, value);
  } catch {
    // No env permission: this process remembers it below; its children may repeat it.
  }
};

/** Whether this process printed the notice (for a process whose env can't be written). */
let shownHere = false;

const truthy = (value: string | undefined) => {
  const v = (value ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
};

/**
 * Print the stock-Deno deprecation notice, once per process tree: not when this process or an
 * ancestor already printed it ({@linkcode STOCK_DEPRECATION_SHOWN_ENV}), nor under
 * `DENEXT_NO_DEPRECATION_WARNINGS=1`. Injected `env` / `setEnv` (seams) replace the process's
 * state entirely: an injected `env` without `setEnv` marks nothing.
 *
 * @param path The path that runs on stock Deno.
 * @param deps Seams; all default to the process.
 * @returns Whether the notice was printed.
 */
export function warnStockDeprecation(
  path: StockDenoPath,
  deps: StockDeprecationDeps = {},
): boolean {
  const own = deps.env === undefined && deps.setEnv === undefined;
  const env = deps.env ?? processEnv;
  if (truthy(env(NO_DEPRECATION_WARNINGS_ENV))) return false;
  if (truthy(env(STOCK_DEPRECATION_SHOWN_ENV))) return false;
  if (own && shownHere) return false;
  (deps.warn ?? ((m: string) => console.error(m)))(stockDeprecationNotice(path));
  if (own) {
    shownHere = true;
    processSetEnv(STOCK_DEPRECATION_SHOWN_ENV, "1");
  } else deps.setEnv?.(STOCK_DEPRECATION_SHOWN_ENV, "1");
  return true;
}

/**
 * The notice for library code (`createTestApp()`) run in a process that is not denext's Deno: a
 * plain `deno test` / `deno task` under stock Deno. Silent on denext's Deno.
 *
 * @param identity This process's Deno (default {@linkcode currentDenoIdentity}).
 * @param deps Seams for {@linkcode warnStockDeprecation}.
 * @returns Whether the notice was printed.
 */
export function warnIfStockDeno(
  identity: DenoIdentity = currentDenoIdentity(),
  deps: StockDeprecationDeps = {},
): boolean {
  if (isDenextDenoVersion(identity)) return false;
  return warnStockDeprecation("stock-process", deps);
}
