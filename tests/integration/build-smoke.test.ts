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

Deno.test("build smoke: examples/hello emits a client entry, a code-split island chunk, and a shared chunk", async () => {
  const result = await build(EXAMPLE);
  const clientDir = join(result.outDir, "client");

  // BLD-M2: the client is built in a staging dir and atomically swapped in, so no
  // `.client.staging` should survive a successful build.
  await assertRejects(
    () => Deno.stat(join(result.outDir, ".client.staging")),
    Deno.errors.NotFound,
  );

  const files: string[] = [];
  for await (const entry of Deno.readDir(clientDir)) {
    if (entry.isFile) files.push(entry.name);
  }
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

  // L2 (DCE tripwire): the dev-only Fast Refresh runtime must be tree-shaken out
  // of EVERY production client file. The byte budgets above are a coarse proxy;
  // this asserts the property directly. `enableFastRefresh`/`registerFamily` are
  // the entry-point calls; `setFamilyMatch`/`setSignatureChangeHandler` are the
  // reconciler seams the runtime installs — none may appear in a prod bundle.
  const refreshMarkers = [
    "enableFastRefresh",
    "registerFamily",
    "setFamilyMatch",
    "setSignatureChangeHandler",
    "__denextRefreshing",
  ];
  for (const f of files) {
    if (!f.endsWith(".js")) continue;
    const src = await Deno.readTextFile(join(clientDir, f));
    for (const marker of refreshMarkers) {
      assert(
        !src.includes(marker),
        `prod client file ${f} must not contain dev Fast Refresh symbol "${marker}"`,
      );
    }
  }

  // Every route entry SHARES the client-runtime chunk rather than inlining it:
  // collect the chunks each entry statically imports and assert they reference a
  // common one. (Before the shared-bundle pass, sibling routes each inlined a
  // full ~19 KB copy of the runtime.)
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

  // Bundle budget (raw bytes). The shared chunks hold the runtime and stay small;
  // each route entry is just its own code. If the runtime is ever inlined per
  // route again, a sibling entry balloons past its budget and this trips.
  let sharedTotal = 0;
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && /^chunk-.*\.js$/.test(e.name)) {
      sharedTotal += (await Deno.stat(join(clientDir, e.name))).size;
    }
  }
  // Raw-byte smoke guard on the shared runtime. Bumped for the 1.0 reconciler
  // features (pre-mutation insertion effects, async transitions, forwardRef/memo type
  // resolution, Suspense Offscreen) and path-based useId (tree-position ids across
  // the shell/hole boundary), which grew the shared runtime a further ~0.4%. Nudged
  // again (44.5 → 44.7 KB) for the soft-nav retained-root fix: the root must live on a
  // document-global so a dev soft nav's self-contained re-run bundle finds it instead
  // of re-hydrating against the outgoing page (~40 raw bytes of repetitive global
  // property access; a handful of bytes gzipped). Bumped once more (44.7 → 45.3 KB) for
  // the compact isomorphic soft-nav payload: an interactive-but-non-Flight route now
  // gets a JSON `{title,data,entry,styles}` reply on nav instead of a full HTML document
  // whose `<body>` the client discards — so the client gained `applyIsoNav` +
  // `swapRouteStyles` (per-route CSS is now swapped on nav, previously a latent bug).
  // That is +642 raw / +207 gzipped on the shared chunk, spent once to stop shipping the
  // full rendered document on every isomorphic navigation (kilobytes each) and to fix the
  // CSS swap. The gzip floor (the real over-the-wire commitment) is verified by bench
  // Layer 1; the per-route inlining regression this guards against is caught directly by
  // the 6 KB per-route entry budget below.
  // Bumped once more (45.3 → 50 KB; shared runtime is now ~49.3 KB raw / ~16.5 KB gzipped)
  // for the 1.2 real-DOM-fidelity fixes that let heavy npm React apps (TanStack Router +
  // Base UI/floating-ui) render correctly on the reconciler: SVG/MathML elements created
  // in-namespace so icons render; passive effects flushed before each render-loop iteration
  // so no useEffect is stranded; and per-property inline-style patching (`patchStyle`) so
  // foreign CSS custom props set imperatively by floating-ui survive a re-render (previously
  // the whole `style` attribute was rewritten each commit, wiping `--available-height`/
  // `--anchor-width`/… and driving a floating-ui reposition loop). Together ~+3.3 KB raw /
  // ~+1.1 KB gzipped on the shared runtime — the over-the-wire cost is the gzip figure. The
  // per-route 6 KB budget below still guards against the runtime being inlined into entries.
  // Bumped 50 → 52 KB for streaming-on-by-default: `startClient` now runs a synchronous
  // hole-reveal sweep (src/client/reveal-holes.ts) before hydrating, so a streamed Suspense
  // hole not yet swapped by the inline runtime is revealed before hydrateRoot reads the DOM
  // (ordering safety; a no-op on buffered pages). ~+1.4 KB raw / ~+0.3 KB gzipped.
  //
  // Bumped 52 → 55 KB to match the runtime as it actually stands (53.8 KB raw / 18.7 KB
  // gzipped) — the real-DOM-fidelity, path-based `useId`, and compact-nav-payload work grew
  // it past the old raw guard without a bump. The over-the-wire cost is the GZIPPED figure,
  // 18.7 KB — for context React 19 (`react` + `react-dom-client` + `scheduler`) is ~90-100 KB
  // gzipped for the reconciler alone, and denext's 18.7 KB already includes the router and the
  // Flight client. So this raw guard is only a "did the runtime get inlined into a route entry"
  // tripwire (the 6 KB per-route budget below is the real one); it is not an over-the-wire budget.
  //
  // Back down to ~51.6 KB raw as of the DevTools-panel DCE fix: the dev-only panel's top-level
  // `const S = {…}` style object was being retained by esbuild in EVERY production bundle (~2 KB
  // of dead style strings) even though its `mount()` was tree-shaken — a bare module-scope object
  // literal survives DCE where the functions using it do not. Moving the styles inside `mount()`
  // (via `buildStyles()`) lets them shake out with it, so the whole panel is now absent from prod.
  // Re-bumped to 56 KB (from 55 KB) for the unbundled dev loop's per-module HMR seam: the
  // reconciler now resolves a component through its family's CURRENT impl at render time
  // (`resolveFamilyCurrent`/`familyResolveActive` in vnode-utils, plus `refreshAllRoots`),
  // which ships to prod even though the resolver is null there (the branch is a null-check,
  // never taken). A deliberate ~small feature addition, not a DCE leak — the guard still
  // trips on a larger regression.
  // Re-based 56 → 58 KB for the reconciler refactor (Phase 1: the ten over-threshold
  // functions decomposed into named helpers; Phase 2: the 3.4k-line module split into 17
  // layered modules). Measured on this example: 55.8 → 57.4 KB raw, 19.5 → 20.2 KB gzipped
  // for the shared runtime. The cost is structural — esbuild does not inline the extracted
  // helpers, so each one keeps its declaration + call overhead — and deliberate: the old
  // guard had 231 bytes of headroom, so ANY decomposition tripped it. Still a tripwire for
  // the runtime being inlined into a route entry, not an over-the-wire budget.
  assert(sharedTotal < 58_000, `shared chunks total ${sharedTotal} bytes (budget 58 KB raw)`);
  for (const f of ["about.js", "blog___slug_.js"]) {
    const n = (await Deno.stat(join(clientDir, f))).size;
    assert(n < 6_000, `${f} is ${n} bytes (budget 6 KB) — is the runtime inlined again?`);
  }
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
