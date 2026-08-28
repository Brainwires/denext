// Internal helper spawned by `refresh.ts` inside a temp directory whose
// `node_modules` holds the pinned React/ReactDOM/Next(-intl) + `@types` + typescript
// install. It runs the TS-compiler-API extraction (`extract-real.ts`) against that
// install and prints `{ versions, surfaces }` as JSON to stdout.
//
// It is run in a child process (cwd = the temp dir, `--node-modules-dir=auto`) so the
// `npm:typescript` import and Node module resolution both resolve from the temp
// install — keeping the repo root free of a stray `node_modules`. Not a public entry.

import { extractRealSurfaces, readVersions } from "./extract-real.ts";

const workDir = Deno.args[0] ?? Deno.cwd();
const surfaces = extractRealSurfaces(workDir);
const versions = readVersions(workDir);
console.log(JSON.stringify({ versions, surfaces }));
