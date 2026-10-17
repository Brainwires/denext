// denext's pinned Deno toolchain as a test runs it: the cached binary (no download), and the
// environment a `denext toolchain link`ed shell gives a process started on it.

import { dirname, join } from "@std/path";
import { denoToolchainCacheRoot, loadDenoToolchainPin } from "../../src/build/deno-toolchain.ts";

/** The pinned toolchain binary in the cache, or null (not installed, or no pin). */
export function cachedToolchain(): string | null {
  try {
    const { version } = loadDenoToolchainPin();
    if (!version) return null;
    const exe = Deno.build.os === "windows" ? "deno.exe" : "deno";
    const bin = join(denoToolchainCacheRoot(), version, `${Deno.build.os}-${Deno.build.arch}`, exe);
    return Deno.statSync(bin).isFile ? bin : null;
  } catch {
    return null;
  }
}

/** The environment a `toolchain link`ed shell gives the CLI: the toolchain first on PATH. */
export function linkedEnv(deno: string): Record<string, string> {
  const sep = Deno.build.os === "windows" ? ";" : ":";
  return {
    PATH: `${dirname(deno)}${sep}${Deno.env.get("PATH") ?? ""}`,
    NO_COLOR: "1",
    // Nothing the test's own process carries may decide the CLI's path.
    DENEXT_TOOLCHAIN_ACTIVE: "",
    DENEXT_RUNTIME_FLAGS_FOR: "",
    DENEXT_DENO: "",
    DENO_BIN: "",
  };
}
