// `deno bundle --define` on the native client path (src/build/bundle.ts): the feature probe,
// the defines a native bundle gets, and `feature()` / the class-component gate behaving the same
// on both paths: `--define` (denext's Deno toolchain) and the seeded fallback a stock Deno takes.
// The bundling tests shell out to `deno bundle`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  __setBundleDefineForTests,
  bundleFlightEntry,
  bundleRoute,
  bundleSourceFiles,
  bundleSupportsDefine,
  nativeBundleDefines,
} from "../src/build/bundle.ts";
import type { BoundaryManifest } from "../src/build/module-graph.ts";
import type { PageRoute } from "../src/router/manifest.ts";
import { parsePattern } from "../src/router/segments.ts";

const BUNDLE_URL = new URL("../src/build/bundle.ts", import.meta.url).href;
const ROOT = new URL("../", import.meta.url).href;

/** Whether this process's `deno bundle` takes `--define` (the real probe, run once). */
const DEFINE = await bundleSupportsDefine();
/** The paths this Deno can exercise: the seeded fallback always, `--define` when it has it. */
const PATHS: ReadonlyArray<boolean> = DEFINE ? [false, true] : [false];
const label = (define: boolean) => define ? "--define" : "seeded fallback";

const SEED = "globalThis.__DENEXT_FEATURES__ =";

Deno.test("nativeBundleDefines: the class gate is on unless classRuntime is off", () => {
  assertEquals(nativeBundleDefines({}), { __DENEXT_CLASS_COMPONENTS__: "true" });
  assertEquals(nativeBundleDefines({ classRuntime: "lazy" }), {
    __DENEXT_CLASS_COMPONENTS__: "true",
  });
  assertEquals(nativeBundleDefines({ classRuntime: "eager" }), {
    __DENEXT_CLASS_COMPONENTS__: "true",
  });
  assertEquals(nativeBundleDefines({ classRuntime: "off" }), {
    __DENEXT_CLASS_COMPONENTS__: "false",
  });
});

Deno.test("nativeBundleDefines: features become the __DENEXT_FEATURES__ JSON, absent when unset", () => {
  assertEquals(nativeBundleDefines({ features: { NEW_UI: true, OLD: false } }), {
    __DENEXT_CLASS_COMPONENTS__: "true",
    __DENEXT_FEATURES__: `{"NEW_UI":true,"OLD":false}`,
  });
  assertEquals(nativeBundleDefines({ features: {} }).__DENEXT_FEATURES__, "{}");
  assert(!("__DENEXT_FEATURES__" in nativeBundleDefines({ classRuntime: "off" })));
});

Deno.test("nativeBundleDefines: the build-scan gates are defined only when a scan ran", () => {
  assertEquals(
    nativeBundleDefines({
      usesImageBlur: false,
      usesFormActions: true,
      usesHrefParams: false,
      usesHookBoundaries: false,
    }),
    {
      __DENEXT_CLASS_COMPONENTS__: "true",
      __DENEXT_IMAGE_BLUR__: "false",
      __DENEXT_FORM_ACTIONS__: "true",
      __DENEXT_HREF_PARAMS__: "false",
      __DENEXT_HOOK_BOUNDARIES__: "false",
    },
  );
  const unscanned = nativeBundleDefines({});
  assert(!("__DENEXT_IMAGE_BLUR__" in unscanned) && !("__DENEXT_FORM_ACTIONS__" in unscanned));
  assert(!("__DENEXT_HREF_PARAMS__" in unscanned));
  assert(!("__DENEXT_HOOK_BOUNDARIES__" in unscanned));
});

/** Run the probe in a fresh process with `DENO_BIN` set to a fake `deno` script (POSIX only). */
async function probeWithFakeDeno(script: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_fakedeno_define_" });
  try {
    const fake = join(dir, "deno");
    await Deno.writeTextFile(fake, `#!/bin/sh\n${script}\n`);
    await Deno.chmod(fake, 0o755);
    const code = `Deno.env.set("DENO_BIN", ${JSON.stringify(fake)});` +
      `const { bundleSupportsDefine } = await import(${JSON.stringify(BUNDLE_URL)});` +
      `console.log("PROBE:" + await bundleSupportsDefine());`;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", code],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return new TextDecoder().decode(out.stdout).trim();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const POSIX = Deno.build.os !== "windows";

Deno.test({
  name: "bundleSupportsDefine: true when `deno bundle --help` lists --define",
  ignore: !POSIX,
}, async () => {
  const help = `echo '  --define <KEY=VALUE>  Replace a global identifier'`;
  assertEquals(await probeWithFakeDeno(help), "PROBE:true");
});

Deno.test({
  name: "bundleSupportsDefine: false for a deno whose bundle has no --define",
  ignore: !POSIX,
}, async () => {
  const help = `echo '  --code-splitting    Enable code splitting'`;
  assertEquals(await probeWithFakeDeno(help), "PROBE:false");
});

Deno.test({
  name: "bundleSupportsDefine: false (never a throw) when the help run fails",
  ignore: !POSIX,
}, async () => {
  assertEquals(await probeWithFakeDeno(`echo '--define' >&2; exit 2`), "PROBE:false");
  // A DENO_BIN that cannot be spawned at all.
  const code = `Deno.env.set("DENO_BIN", "/nonexistent/denext-no-deno");` +
    `const { bundleSupportsDefine } = await import(${JSON.stringify(BUNDLE_URL)});` +
    `console.log("PROBE:" + await bundleSupportsDefine());`;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", code],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(new TextDecoder().decode(out.stdout).trim(), "PROBE:false");
});

// denext's Deno toolchain (2.9.7-denext.N / 3.0.0-rc.N) carries `deno bundle --define`.
Deno.test({
  name: "bundleSupportsDefine: denext's Deno toolchain takes --define",
  ignore: !/denext|^3\./.test(Deno.version.deno),
}, () => {
  assert(DEFINE, `deno ${Deno.version.deno} should take deno bundle --define`);
});

/** A temp project whose import map reaches the framework from this checkout. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_bundle_define_" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
      imports: {
        "denext": `${ROOT}mod.ts`,
        "denext/feature": `${ROOT}src/feature.ts`,
        "denext/jsx-runtime": `${ROOT}src/jsx/jsx-runtime.ts`,
        "denext/client": `${ROOT}src/client/mod.ts`,
        "denext/client-runtime": `${ROOT}src/client/client-runtime.ts`,
        "react": `${ROOT}src/compat/react.ts`,
      },
    }),
  );
  for (const [name, src] of Object.entries(files)) await Deno.writeTextFile(join(dir, name), src);
  return dir;
}

/** Write bundle output files into `dir` and return the concatenated JS. */
async function writeOut(dir: string, files: Map<string, string>): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  for (const [name, code] of files) await Deno.writeTextFile(join(dir, name), code);
  return [...files.values()].join("\n");
}

// The case the seed exists for: a `feature()` call the build fold cannot resolve (a namespace
// import with a non-literal key, in a plain `.ts` util an island imports). On both paths the
// shipped island reads the configured flag: through the `--define`d map, or the entry's seed.
for (const define of PATHS) {
  Deno.test(`native Flight bundle (${label(define)}): an un-folded feature() reads the configured flag`, async () => {
    const dir = await project({
      "util.ts": `import * as f from "denext/feature";\n` +
        `const keys = ["FLAG", "UNSET"];\n` +
        `export const flags = keys.map((k) => f.feature(k));\n`,
      "Widget.tsx": `"use client"\nimport { flags } from "./util.ts";\n` +
        `(globalThis as Record<string, unknown>).__flagReads = flags;\n` +
        `export function Widget() { return <span>WIDGET_MARKER</span>; }\n`,
    });
    __setBundleDefineForTests(define);
    try {
      const boundary: BoundaryManifest = {
        client: new Map([
          ["c_widget", { url: toFileUrl(join(dir, "Widget.tsx")).href, exports: ["Widget"] }],
        ]),
        server: new Map(),
      };
      const out = await bundleFlightEntry(boundary, {
        configPath: join(dir, "deno.json"),
        features: { FLAG: true, OTHER: false },
      });
      const outDir = join(dir, "out");
      await writeOut(outDir, out.files);
      const entry = out.files.get(out.entry)!;
      // The seed is in the entry only on the fallback path.
      assertEquals(entry.includes(SEED), !define, `seed ${define ? "emitted" : "missing"}`);
      const island = [...out.files].find(([, code]) => code.includes("WIDGET_MARKER"));
      assert(island, "the island chunk");
      // Load the entry (its main() finds no document root and returns), then the island chunk.
      const code =
        `globalThis.document = { getElementById: () => null, querySelector: () => null };` +
        `await import(${JSON.stringify(toFileUrl(join(outDir, out.entry)).href)});` +
        `await import(${JSON.stringify(toFileUrl(join(outDir, island[0])).href)});` +
        `console.log("READS:" + JSON.stringify(globalThis.__flagReads));`;
      const run = await new Deno.Command(Deno.execPath(), {
        args: ["eval", code],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(run.stdout);
      assertStringIncludes(
        stdout,
        "READS:[true,false]",
        `stdout: ${stdout}\nstderr: ${new TextDecoder().decode(run.stderr)}`,
      );
    } finally {
      __setBundleDefineForTests(undefined);
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// `classComponents: false` (classRuntime "off"): with `--define` the reconciler's class paths
// fold out of a native bundle, as on the esbuild paths; the seeded fallback keeps them (the gate
// reads its runtime default, on). Either way an on build keeps them, and with the define the
// flag's `globalThis` default (class-flag.ts) folds away too.
for (const define of PATHS) {
  Deno.test(`native bundle (${label(define)}): the class-component gate`, async () => {
    const dir = await project({});
    __setBundleDefineForTests(define);
    try {
      const entry = `import { Component } from "react";\n` +
        `(globalThis as Record<string, unknown>).C = Component;\n`;
      // Every file but the on-demand `class-runtime-*` chunk (the class-loader's dynamic import,
      // which code splitting emits either way and an off page never loads).
      const bundle = async (classRuntime: "off" | "lazy") =>
        [
          ...(await bundleSourceFiles(entry, {
            configPath: join(dir, "deno.json"),
            classRuntime,
            minify: true,
          })).files,
        ].filter(([name]) => !name.startsWith("class-runtime")).map(([, code]) => code).join("\n");
      const off = await bundle("off");
      const on = await bundle("lazy");
      // The reconciler's class-instance paths (client/fiber/: `fiber.ext?.classInstance`
      // behind the gate) fold out of an off build with the define, and stay without it.
      const classReads = (code: string) => code.split("classInstance").length - 1;
      if (define) {
        assert(
          classReads(off) < classReads(on),
          `class reads: off ${classReads(off)}, on ${classReads(on)}`,
        );
        assert(off.length < on.length, `off ${off.length} B, on ${on.length} B`);
      } else {
        assertEquals(off, on, "without --define the class gate is the runtime default (on)");
      }
      for (const out of [off, on]) {
        assertEquals(out.includes("__DENEXT_CLASS_COMPONENTS__"), !define, "the runtime flag");
      }
    } finally {
      __setBundleDefineForTests(undefined);
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// The lazy class runtime still loads as its own chunk when the gate is a defined `true`.
for (const define of PATHS) {
  Deno.test(`native Flight bundle (${label(define)}): the lazy class runtime is its own chunk`, async () => {
    const dir = await project({});
    __setBundleDefineForTests(define);
    try {
      const out = await bundleFlightEntry({ client: new Map(), server: new Map() }, {
        configPath: join(dir, "deno.json"),
        classRuntime: "lazy",
      });
      const names = [...out.files.keys()];
      assert(
        names.some((n) => n.startsWith("class-runtime")),
        `expected a class-runtime-*.js chunk; got: ${names.join(", ")}`,
      );
    } finally {
      __setBundleDefineForTests(undefined);
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// The build-scan gates (src/globals.d.ts): with `--define` an app the scan found no use in ships
// neither the boot's blur-placeholder clearing nor the reconciler's form-action seam, and an app
// that uses them (or a bundle no scan ran for, or the seeded fallback) keeps both. Without the
// seam no `form-action-*` chunk is emitted: nothing could load it.
for (const define of PATHS) {
  Deno.test(`native bundle (${label(define)}): the blur and form-action build-scan gates`, async () => {
    const dir = await project({});
    __setBundleDefineForTests(define);
    try {
      const entry =
        `import { startClient } from ${JSON.stringify(`${ROOT}src/client/navigation.ts`)};\n` +
        `import { applyProps } from ${JSON.stringify(`${ROOT}src/client/dom-props.ts`)};\n` +
        `(globalThis as Record<string, unknown>).x = [startClient, applyProps];\n`;
      const bundle = async (gates: { usesImageBlur?: boolean; usesFormActions?: boolean }) => {
        const out = await bundleSourceFiles(entry, {
          configPath: join(dir, "deno.json"),
          minify: true,
          ...gates,
        });
        return { names: [...out.files.keys()], code: [...out.files.values()].join("\n") };
      };
      const off = await bundle({ usesImageBlur: false, usesFormActions: false });
      const on = await bundle({ usesImageBlur: true, usesFormActions: true });
      const unscanned = await bundle({});
      for (const kept of define ? [on, unscanned] : [off, on, unscanned]) {
        assertStringIncludes(kept.code, 'tagName==="IMG"');
        assert(kept.names.some((n) => n.startsWith("form-action-")), kept.names.join(", "));
      }
      if (define) {
        assert(!off.code.includes('tagName==="IMG"'), "blur clearing in an app with no blur");
        assert(!off.code.includes("data-dnx-blur"), "image-blur.ts in an app with no blur");
        assert(!off.names.some((n) => n.startsWith("form-action-")), off.names.join(", "));
        assert(!off.code.includes("__DENEXT_FORM_ACTIONS__"), "the gate folded");
      }
    } finally {
      __setBundleDefineForTests(undefined);
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// The route-pattern href gate: with `--define` an app the scan found no pattern href in ships no
// route-segment parser behind formatHref; one that writes a pattern (or a bundle no scan ran for,
// or the seeded fallback) keeps it, and the pattern still fills from its params.
for (const define of PATHS) {
  Deno.test(`native bundle (${label(define)}): the route-pattern href build-scan gate`, async () => {
    const dir = await project({});
    __setBundleDefineForTests(define);
    try {
      const entry =
        `import { formatHref } from ${JSON.stringify(`${ROOT}src/client/navigation.ts`)};\n` +
        `(globalThis as Record<string, unknown>).x = formatHref;\n`;
      const bundle = async (usesHrefParams?: boolean) => {
        const out = await bundleSourceFiles(entry, {
          configPath: join(dir, "deno.json"),
          minify: true,
          usesHrefParams,
        });
        return [...out.files.values()].join("\n");
      };
      const off = await bundle(false);
      for (
        const kept of define ? [await bundle(true), await bundle()] : [off, await bundle(true)]
      ) {
        assertStringIncludes(kept, '"optionalCatchAll"');
      }
      if (define) {
        assert(
          !off.includes('"optionalCatchAll"'),
          "the segment parser in an app with no pattern",
        );
        assert(!off.includes("__DENEXT_HREF_PARAMS__"), "the gate folded");
      }
    } finally {
      __setBundleDefineForTests(undefined);
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// The hook-boundary gate (Preact's `useErrorBoundary`): with `--define` an app the scan found no
// use in carries no component-boundary seam in the reconciler's boundary search; one that uses it (or
// a bundle no scan ran for) keeps it.
for (const define of PATHS) {
  Deno.test(`native bundle (${label(define)}): the hook-boundary build-scan gate`, async () => {
    const dir = await project({});
    __setBundleDefineForTests(define);
    try {
      const entry = `import { findErrorBoundary } from ${
        JSON.stringify(`${ROOT}src/client/fiber/fiber-utils.ts`)
      };\n(globalThis as Record<string, unknown>).x = findErrorBoundary;\n`;
      const bundle = async (usesHookBoundaries?: boolean) => {
        const out = await bundleSourceFiles(entry, {
          configPath: join(dir, "deno.json"),
          minify: true,
          usesHookBoundaries,
        });
        return [...out.files.values()].join("\n");
      };
      const off = await bundle(false);
      const on = await bundle(true);
      const unscanned = await bundle();
      if (define) {
        // Off, the component-boundary seam (its slot and its call) is gone; on, it stays.
        assert(off.length < on.length, `off ${off.length} B, on ${on.length} B`);
        assert(unscanned.length >= on.length, "an unscanned bundle keeps the seam");
        assert(!off.includes("__DENEXT_HOOK_BOUNDARIES__"), "the gate folded");
      } else {
        // No `--define`: every build keeps it (the runtime default reads the gate as on).
        assertEquals(off.length, on.length);
      }
    } finally {
      __setBundleDefineForTests(undefined);
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// The class gate off with `--define`: the class-runtime chunk's `import()` site folds away, and
// a chunk nothing can load is not emitted.
if (DEFINE) {
  Deno.test("native bundle (--define): classComponents off emits no class-runtime chunk", async () => {
    const dir = await project({});
    __setBundleDefineForTests(true);
    try {
      const out = await bundleFlightEntry({ client: new Map(), server: new Map() }, {
        configPath: join(dir, "deno.json"),
        classRuntime: "off",
      });
      const names = [...out.files.keys()];
      assert(!names.some((n) => n.startsWith("class-runtime")), names.join(", "));
    } finally {
      __setBundleDefineForTests(undefined);
      await Deno.remove(dir, { recursive: true });
    }
  });
}

// A route entry imports its page statically, so a page's module-level `feature()` call runs before
// any statement of the entry: on the seeded fallback the seed is a `data:` import placed first.
// The dev server's route bundles pass the flags too (they once passed none).
for (const define of PATHS) {
  Deno.test(`native route bundle (${label(define)}): a page's module-level feature() reads the flag`, async () => {
    const dir = await project({
      "page.tsx": `import * as f from "denext/feature";\n` +
        `const keys = ["FLAG", "UNSET"];\n` +
        `(globalThis as Record<string, unknown>).__pageReads = keys.map((k) => f.feature(k));\n` +
        `export default function Page() { return <p>page</p>; }\n`,
    });
    __setBundleDefineForTests(define);
    try {
      const route: PageRoute = {
        kind: "page",
        pattern: parsePattern(""),
        routePath: "/",
        filePath: join(dir, "page.tsx"),
        layoutChain: [],
        loading: null,
        error: null,
        notFound: null,
        forbidden: null,
        unauthorized: null,
        templateChain: [],
      };
      const out = await bundleRoute(route, {
        configPath: join(dir, "deno.json"),
        features: { FLAG: true, OTHER: false },
      });
      const outDir = join(dir, "out");
      await writeOut(outDir, out.files);
      const code = `globalThis.document = { getElementById: () => null };` +
        `await import(${JSON.stringify(toFileUrl(join(outDir, out.entry)).href)});` +
        `console.log("READS:" + JSON.stringify(globalThis.__pageReads));`;
      const run = await new Deno.Command(Deno.execPath(), {
        args: ["eval", code],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stdout = new TextDecoder().decode(run.stdout);
      assertStringIncludes(
        stdout,
        "READS:[true,false]",
        `stdout: ${stdout}\nstderr: ${new TextDecoder().decode(run.stderr)}`,
      );
    } finally {
      __setBundleDefineForTests(undefined);
      await Deno.remove(dir, { recursive: true });
    }
  });
}
