// Full-build smoke test: run the real production `build()` on examples/hello and
// assert the on-disk artifact shape. This is the tripwire for the experimental
// `deno bundle` subcommand — if a future Deno changes its output (entry name,
// code-split chunk emission), this fails loudly instead of silently shipping a
// broken client bundle. It also covers the ssr:false code-split path end to end.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { build } from "../../src/build/build.ts";

const BUNDLE_URL = new URL("../../src/build/bundle.ts", import.meta.url).href;

const EXAMPLE = new URL("../../examples/hello", import.meta.url).pathname;

/** File names directly in `dir`. */
async function fileNames(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile) files.push(entry.name);
  }
  return files;
}

/**
 * L2 (DCE tripwire): the dev-only Fast Refresh runtime must be tree-shaken out of EVERY
 * production client file. The byte budgets are a coarse proxy; this asserts the property
 * directly. `enableFastRefresh`/`registerFamily` are the entry-point calls;
 * `setFamilyMatch`/`setSignatureChangeHandler` are the reconciler seams the runtime
 * installs — none may appear in a prod bundle.
 */
async function assertNoRefreshRuntime(clientDir: string, files: string[]): Promise<void> {
  const refreshMarkers = [
    "enableFastRefresh",
    "registerFamily",
    "setFamilyMatch",
    "setSignatureChangeHandler",
    "__denextRefreshing",
  ];
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    const src = await Deno.readTextFile(join(clientDir, f));
    for (const marker of refreshMarkers) {
      assert(
        !src.includes(marker),
        `prod client file ${f} must not contain dev Fast Refresh symbol "${marker}"`,
      );
    }
  }
}

/**
 * L2b (server-leak tripwire): no production client file may import a `node:` builtin.
 * A server module reachable from the client graph (e.g. `node:async_hooks` via the
 * request context) is refused by the strict CSP, so hydration silently never runs —
 * the bundle still parses and no exception surfaces, which is why this needs a test.
 */
async function assertNoNodeBuiltins(clientDir: string, files: string[]): Promise<void> {
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    const src = await Deno.readTextFile(join(clientDir, f));
    const hit = /\bfrom\s*["']node:[^"']+["']|\bimport\(\s*["']node:/.exec(src);
    assert(
      !hit,
      `prod client file ${f} imports a Node builtin (${
        hit?.[0]
      }) — a server module leaked into the client graph`,
    );
  }
}

/**
 * Every route entry SHARES the client-runtime chunk rather than inlining it: collect the
 * chunks each entry statically imports and assert they reference a common one. (Before
 * the shared-bundle pass, sibling routes each inlined a full ~19 KB copy of the runtime.)
 */
async function assertSharedRuntimeChunk(clientDir: string): Promise<void> {
  const importedChunks = (js: string): string[] =>
    [...js.matchAll(/from\s*["']\.\/(chunk-[A-Za-z0-9]+\.js)["']/g)].map((m) => m[1]);
  const routeEntries = ["index.js", "about.js", "blog___slug_.js"];
  const perEntry = await Promise.all(
    routeEntries.map(async (f) => importedChunks(await Deno.readTextFile(join(clientDir, f)))),
  );
  const shared = perEntry[0].find((c) => perEntry.every((cs) => cs.includes(c)));
  assert(
    shared,
    `all route entries must import one shared runtime chunk; got ${
      routeEntries.map((f, i) => `${f}:[${perEntry[i].join(",")}]`).join(" ")
    }`,
  );
}

/**
 * Bundle budget (raw bytes). The shared chunks hold the runtime and stay small; each
 * route entry is just its own code. If the runtime is ever inlined per route again, a
 * sibling entry balloons past its budget and this trips.
 *
 * History of the shared-runtime guard: bumped for the 1.0 reconciler features and
 * path-based useId; nudged for the soft-nav retained-root fix (44.5 → 44.7 KB); bumped for
 * the compact isomorphic soft-nav payload (44.7 → 45.3 KB, +642 raw / +207 gzipped, spent
 * once to stop shipping the full rendered document on every isomorphic navigation and to
 * fix the per-route CSS swap); bumped 45.3 → 50 KB for the 1.2 real-DOM-fidelity fixes
 * (in-namespace SVG/MathML, passive effects flushed per render-loop iteration, per-property
 * `patchStyle` so floating-ui's CSS custom props survive a re-render; ~+3.3 KB raw /
 * ~+1.1 KB gzipped); 50 → 52 KB for streaming-on-by-default's synchronous hole-reveal
 * sweep (~+1.4 KB raw); 52 → 55 KB to match the runtime as it actually stood (53.8 KB raw /
 * 18.7 KB gzipped — for context React 19's reconciler alone is ~90–100 KB gzipped, and
 * denext's figure includes the router and the Flight client); back down to ~51.6 KB raw
 * with the DevTools-panel DCE fix (a bare module-scope style object was retained in every
 * prod bundle); re-bumped to 56 KB for the unbundled dev loop's per-module HMR seam
 * (`resolveFamilyCurrent`/`refreshAllRoots`, a null-check branch in prod); re-based
 * 56 → 58 KB for the reconciler refactor (55.8 → 57.4 KB raw, 19.5 → 20.2 KB gzipped —
 * esbuild does not inline the extracted helpers, so each keeps its declaration + call
 * overhead; the old guard had 231 bytes of headroom, so ANY decomposition tripped it);
 * re-based 58 → 59 KB for the 2.0 Next-parity navigation surface (Link: user handler/ref
 * composition, `target`/`download` respect, `legacyBehavior`, `UrlObject` hrefs, the three
 * `prefetch` modes; useRouter: one stable object with `prefetch` + scroll options; the
 * client boot clearing server-rendered image blur placeholders — ~+0.4 KB raw).
 * The over-the-wire cost is the GZIPPED figure, verified by bench Layer 1; this raw guard
 * is a "did the runtime get inlined into a route entry" tripwire, not an over-the-wire
 * budget — the 6 KB per-route entry budget is the real one.
 */
async function assertBundleBudgets(clientDir: string): Promise<void> {
  let sharedTotal = 0;
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && /^chunk-.*\.js$/.test(e.name)) {
      sharedTotal += (await Deno.stat(join(clientDir, e.name))).size;
    }
  }
  assert(sharedTotal < 59_000, `shared chunks total ${sharedTotal} bytes (budget 59 KB raw)`);
  for (const f of ["about.js", "blog___slug_.js"]) {
    const n = (await Deno.stat(join(clientDir, f))).size;
    assert(n < 6_000, `${f} is ${n} bytes (budget 6 KB) — is the runtime inlined again?`);
  }
}

Deno.test("build smoke: examples/hello emits a client entry, a code-split island chunk, and a shared chunk", async () => {
  const result = await build(EXAMPLE);
  const clientDir = join(result.outDir, "client");

  // BLD-M2: the client is built in a staging dir and atomically swapped in, so no
  // `.client.staging` should survive a successful build.
  await assertRejects(
    () => Deno.stat(join(result.outDir, ".client.staging")),
    Deno.errors.NotFound,
  );

  const files = await fileNames(clientDir);
  const list = files.join(", ");
  // The home route's client entry.
  assert(files.includes("index.js"), `expected index.js in client output; got: ${list}`);
  // `dynamic(() => import("./island.tsx"), { ssr: false })` is split into its own chunk.
  assert(
    files.some((f) => f.startsWith("island-") && f.endsWith(".js")),
    `expected a code-split island-*.js chunk; got: ${list}`,
  );
  // Code-splitting hoists shared modules (the client runtime) into a common chunk.
  assert(
    files.some((f) => f.startsWith("chunk-") && f.endsWith(".js")),
    `expected a shared chunk-*.js; got: ${list}`,
  );

  // The build manifest is written.
  const manifest = JSON.parse(await Deno.readTextFile(join(result.outDir, "manifest.json")));
  assert(Array.isArray(manifest.generatedRoutes), "manifest should list generated routes");
  // Static-route tracking is present. examples/hello has none (its shared root
  // error boundary is interactive, so every route hydrates).
  assert(Array.isArray(manifest.staticRoutes), "manifest should list static routes");
  assertEquals(manifest.staticRoutes.length, 0, "examples/hello has no static routes");

  // The entry wires up hydration against the server-rendered root.
  const entry = await Deno.readTextFile(join(clientDir, "index.js"));
  assertStringIncludes(entry, "__denext");

  await assertNoRefreshRuntime(clientDir, files);
  await assertNoNodeBuiltins(clientDir, files);
  await assertSharedRuntimeChunk(clientDir);
  await assertBundleBudgets(clientDir);
});

// The probe is memoized per process, so run it in a subprocess with DENO_BIN
// pointed at a fake `deno` that reports an unsupported version. (POSIX only:
// the fake is a shell script.)
Deno.test({
  name: "bundle support probe rejects an old Deno with a clear, actionable error",
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_fakedeno_" });
  try {
    const fake = join(dir, "deno");
    await Deno.writeTextFile(fake, "#!/bin/sh\necho 'deno 1.40.0 (stable, release)'\n");
    await Deno.chmod(fake, 0o755);

    const code = `Deno.env.set("DENO_BIN", ${JSON.stringify(fake)});` +
      `const { ensureBundleSupport } = await import(${JSON.stringify(BUNDLE_URL)});` +
      `try { await ensureBundleSupport(); console.log("NO_ERROR"); }` +
      `catch (e) { console.log("ERR:" + e.message); }`;

    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", code],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);

    assertStringIncludes(text, "requires Deno 2");
    assertStringIncludes(text, "DENO_BIN");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// M4: a rejected probe must NOT be cached forever. First probe fails (bad
// DENO_BIN), then a retry with a working deno succeeds in the same process.
Deno.test({
  name: "bundle support probe recovers after a transient failure (no cached rejection)",
  ignore: Deno.build.os === "windows",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_probe_reset_" });
  try {
    const badDeno = join(dir, "deno");
    await Deno.writeTextFile(badDeno, "#!/bin/sh\nexit 1\n"); // transient failure
    await Deno.chmod(badDeno, 0o755);

    const code = `const { ensureBundleSupport } = await import(${JSON.stringify(BUNDLE_URL)});` +
      `Deno.env.set("DENO_BIN", ${JSON.stringify(badDeno)});` +
      `let first = "ok"; try { await ensureBundleSupport(); } catch { first = "failed"; }` +
      `Deno.env.set("DENO_BIN", ${JSON.stringify(Deno.execPath())});` +
      `let second = "failed"; try { await ensureBundleSupport(); second = "ok"; } catch {}` +
      `console.log("first=" + first + " second=" + second);`;

    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", code],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assertStringIncludes(text, "first=failed second=ok");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
