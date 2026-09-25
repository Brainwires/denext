// Shared real-surface capture for the native targets: install the given npm deps into a
// throwaway temp dir and extract their public type surface in a child `deno` (the
// `_real-runner.ts` TS-compiler-API extractor). Used by both `refresh.ts` (writes the
// baseline) and `check.ts` (the live side of the react-native gate).
//
// This is the ONLY part of the native harness that touches npm/network. It installs into
// a temp dir via `--node-modules-dir=auto` so the repo root stays clean, mirroring
// `../refresh.ts`'s `captureReal`.

import type { RealTarget } from "../extract-real.ts";
import type { Surface } from "../types.ts";
import { npmInstall, parseExtractorOutput } from "./shared.ts";

const RUNNER = new URL("./_real-runner.ts", import.meta.url).pathname;

export interface Captured {
  versions: Record<string, string>;
  surfaces: Surface[];
}

/**
 * Install `deps` and extract the surface of `targets` in a child process.
 *
 * @param deps npm dependency map (name → version/`"latest"`).
 * @param targets Specifier ↔ npm-import pairs to extract.
 * @param packages Package names to record installed versions for.
 */
export async function captureReal(
  deps: Record<string, string>,
  targets: RealTarget[],
  packages: string[],
): Promise<Captured> {
  const dir = await Deno.makeTempDir({ prefix: "denext_parity_native_" });
  try {
    // typescript is the extractor's own dependency; pin a major so resolution is stable.
    const dependencies = { ...deps, typescript: "^5" };
    await Deno.writeTextFile(
      `${dir}/package.json`,
      JSON.stringify(
        { name: "denext-parity-native-real", private: true, dependencies },
        null,
        2,
      ),
    );

    await npmInstall(dir);

    const specPath = `${dir}/__targets__.json`;
    await Deno.writeTextFile(specPath, JSON.stringify({ targets, packages }));

    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--node-modules-dir=auto", RUNNER, dir, specPath],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return parseExtractorOutput(code, stdout, stderr) as Captured;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
