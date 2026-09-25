// Internal helper spawned by `refresh.ts` / `check.ts` inside a temp directory whose
// `node_modules` holds the pinned react-native-web (and/or expo-*) install. It runs the
// TS-compiler-API extraction (`../extract-real.ts`) against that install and prints
// `{ versions, surfaces }` as JSON to stdout.
//
// Like `../_real-runner.ts`, it runs in a child process (cwd = the temp dir,
// `--node-modules-dir=auto`) so `npm:typescript` and Node module resolution both resolve
// from the temp install, keeping the repo root free of a stray `node_modules`.
//
// argv: [workDir, targetsJsonPath] where the JSON file is `{ targets, packages }`.

import { extractRealSurfacesFor, readVersionsFor, type RealTarget } from "../extract-real.ts";

const workDir = Deno.args[0] ?? Deno.cwd();
const spec = JSON.parse(Deno.readTextFileSync(Deno.args[1])) as {
  targets: RealTarget[];
  packages: string[];
};
const surfaces = extractRealSurfacesFor(workDir, spec.targets);
const versions = readVersionsFor(workDir, spec.packages);
console.log(JSON.stringify({ versions, surfaces }));
