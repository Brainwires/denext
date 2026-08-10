// Feasibility probe: do an app's client React libraries BUNDLE on denext's single
// React? Each library is bundled through denext's next-compat esbuild pipeline
// (react/react-dom/react-is aliased to denext at build time) against the target
// app's already-installed node_modules. A clean bundle proves the library — and its
// transitive deps — resolve onto denext's React with no duplicate-React or missing-
// export breakage; it does not prove runtime rendering (see the recharts example for
// an end-to-end SSR+hydration proof).
//
// Usage (run from the denext repo root):
//   deno run -A --config deno.json examples/next-compat-feasibility/probe-client.ts <app-dir>
//
// <app-dir> is the target app's root (must contain node_modules). Edit CLIENT_LIBS
// to match the app's client dependencies.
import { dirname, fromFileUrl, join } from "@std/path";
import {
  bundleNextCompat,
  prebuildDenextRuntime,
  withEsbuild,
} from "../../src/build/next-compat.ts";

const FRAMEWORK = join(dirname(fromFileUrl(import.meta.url)), "..", "..");

const CLIENT_LIBS = [
  "recharts",
  "sonner",
  "vaul",
  "cmdk",
  "embla-carousel-react",
  "input-otp",
  "react-day-picker",
  "react-resizable-panels",
  "next-themes",
  "react-markdown",
  "prism-react-renderer",
  "@simplewebauthn/browser",
  "@stripe/stripe-js",
  "class-variance-authority",
  "tailwind-merge",
  "tailwindcss-animate",
  "@radix-ui/react-select",
  "@radix-ui/react-dropdown-menu",
  "@dnd-kit/sortable",
  "@hookform/resolvers/zod",
  "react-is",
  "katex",
  "fabric",
  "@techstark/opencv-js",
  "scribe.js-ocr",
];

const appDir = Deno.args[0];
if (!appDir) {
  console.error("usage: deno run -A --config deno.json probe-client.ts <app-dir>");
  Deno.exit(1);
}

const spikeDir = join(appDir, ".denext-feasibility");
await Deno.mkdir(spikeDir, { recursive: true });
await Deno.writeTextFile(join(spikeDir, "deno.json"), JSON.stringify({ nodeModulesDir: "auto" }));

const results: Array<{ lib: string; ok: boolean; kb?: number; err?: string }> = [];
try {
  await withEsbuild(async () => {
    const runtimeDir = await prebuildDenextRuntime({
      outDir: join(spikeDir, ".runtime"),
      frameworkRoot: FRAMEWORK,
      configPath: join(FRAMEWORK, "deno.json"),
      classComponents: true,
    });
    for (const lib of CLIENT_LIBS) {
      const id = lib.replace(/[^\w]/g, "_");
      const entry = join(spikeDir, `e_${id}.tsx`);
      await Deno.writeTextFile(
        entry,
        `import * as X from ${JSON.stringify(lib)};\nexport const k = Object.keys(X).length;\n`,
      );
      const outfile = join(spikeDir, `o_${id}.js`);
      try {
        await bundleNextCompat({
          entry,
          runtimeDir,
          outfile,
          configPath: join(spikeDir, "deno.json"),
          platform: "browser",
          denoLoader: false,
          absWorkingDir: appDir,
          minify: true,
          classComponents: true,
        });
        results.push({ lib, ok: true, kb: Math.round((await Deno.stat(outfile)).size / 1024) });
      } catch (e) {
        results.push({
          lib,
          ok: false,
          err: String((e as Error).message).split("\n")[0].slice(0, 90),
        });
      }
    }
  });
} finally {
  await Deno.remove(spikeDir, { recursive: true }).catch(() => {});
}

for (const r of results) {
  console.log(
    r.ok ? `OK    ${r.lib.padEnd(30)} ${r.kb}KB` : `FAIL  ${r.lib.padEnd(30)} :: ${r.err}`,
  );
}
const okc = results.filter((r) => r.ok).length;
console.log(`\n${okc}/${results.length} client libs bundled on denext's single React.`);
