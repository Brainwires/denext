// Full-build smoke test: run the real production `build()` on examples/hello and
// assert the on-disk artifact shape. This is the tripwire for the experimental
// `deno bundle` subcommand — if a future Deno changes its output (entry name,
// code-split chunk emission), this fails loudly instead of silently shipping a
// broken client bundle. It also covers the ssr:false code-split path end to end.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { build } from "../../src/build/build.ts";
import { bundleSupportsDefine, frameworkRoot } from "../../src/build/bundle.ts";
import { nativeAnalyzeMeta } from "../../src/build/sourcemap-attribution.ts";
import { boundedOutput } from "../helpers/bounded-command.ts";
import { copyExample } from "../helpers/example-copy.ts";
import { dirLinkTestName, IGNORE_WITHOUT_DIR_LINKS, symlinkDir } from "../helpers/symlink.ts";

const BUNDLE_URL = new URL("../../src/build/bundle.ts", import.meta.url).href;

const EXAMPLE = fromFileUrl(new URL("../../examples/hello", import.meta.url));

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
 * client boot clearing server-rendered image blur placeholders — ~+0.4 KB raw);
 * re-based 59 → 60 KB for the 2.0.0 React-parity pass (`useSearchParams` returns a memoized
 * `ReadonlyURLSearchParams` class, SSR-seeded `usePathname`/`useSearchParams`, the
 * rules-of-hooks growth guard, effect deps recorded at commit, `useFormStatus` submission
 * details, the superseded-navigation check — ~+0.7 KB raw).
 * The over-the-wire cost is the GZIPPED figure, verified by bench Layer 1; this raw guard
 * is a "did the runtime get inlined into a route entry" tripwire, not an over-the-wire
 * budget — the 6 KB per-route entry budget is the real one. Re-based 60 → 62 KB for 2.0.5:
 * React's no-op-state bailout (`HookCell.rendered`/`committed`, `Fiber.forceRender`), the
 * component-naming update-depth error, and the code-split island loader (`flightClientIds`,
 * `registry.ensure`) — each a parity/size win worth more than its ~400 bytes. Re-based
 * 62 → 64 KB for 2.1 (measured: 2.1.0-rc.1 shared chunks 61,686 B; the channel-brand split
 * −258 B; `dynamic()`'s Next-shaped loading props — a stateful fallback with `delay`/`timeout`
 * timers, `error` + `retry` — +678 B; the Suspense reveal lanes) with ~1.5 KB of headroom for
 * the rest of the 2.1 cycle. Re-based 64 → 58 KB after the import-gate pass: a function-only
 * app (examples/hello) no longer ships the React-DevTools bridge (−3.3 KB, dev-only seam) or
 * the class-component runtime (−2.4 KB, install emitted only when the app uses classes) —
 * measured 56,558 B, so 58 KB keeps ~1.4 KB of headroom. The gates are asserted directly, not
 * just by byte budget, in {@link assertGatedRuntimeAbsent}. Re-based 58 → 59 KB at the end of the
 * 2.1 cycle: the cycle's client-surface additions (type-safe routing's `useParams`/
 * `useSearchParams` + href param-encoding, the Live `subscribed` status, island box-target/
 * rootMargin, `ViewTransition`/`Activity`, global-error hydration, and soft-nav rejection
 * surfacing) measured 58,164 B — ~0.8 KB of headroom. Re-based 59 → 60 KB for the react-dom
 * numeric-style `px` parity fix (a raw number in an inline `style` now gets a `px` unit unless
 * the property is unitless — the react-dom UNITLESS set + `styleValue`): measured 59,079 B.
 * Re-based 60 → 61 KB for the on-demand class runtime (2.4): the shared graph gains the
 * `loadClassRuntime` loader, the render-scope class marker, and the reconciler's throw-site
 * load (`awaitClassRuntime`) — measured 60,196 B (+0.7 KB) — while the class runtime itself
 * (2.5 KB) now ships as a `class-runtime-*` chunk a function-only page never fetches, and an
 * app whose scan tripped on the word `Component` no longer carries it in this total at all.
 * Re-based 61 → 62 KB for 2.5.0: the hydrator's `suppressHydrationWarning` walk (the nearest
 * host's opt-out, one level) and the DOM-props skip for the marker, on top of the 2.5 cycle's
 * navigation and session additions — measured 61,122 B (+0.9 KB over the 2.4 base).
 * Re-based 62 → 63 KB for the iOS momentum-safe scroll boot (after 2.8.2): every root runs a
 * user-agent test and, on iOS WebKit only, imports the shim as its own `momentum-scroll-*`
 * chunk — +389 B raw in the shared graph (61,950 → 62,339 B); the 4.4 KB shim itself is never
 * in this total. Re-based 63 → 64 KB for library elements (the compat build's `react-lib` /
 * `jsx-runtime-lib` mark the elements npm code creates, and the component bailout keeps
 * React's semantics for them): the reconciler's check is +106 B raw (62,932 → 63,038 B)
 * in every app, and the marking runtime itself ships only in compat builds.
 * Re-based 64 → 65.5 KB (65,500 B) after 3.2.0 (measured 63,939 B: 61 B under the old
 * 64,000 B budget, ~1,561 B under the new one): the auth, passkey and server-ops work kept the
 * shared graph flat, but the old budget had no room left for the next small runtime addition. Native, desktop and mobile code is verified absent from this total.
 * Headroom recovered after 3.4.0 without raising the budget: the shared graph had grown to
 * 65,427 B (Deno 2.9.6, CI's pin; the reconciler's leak fixes after 3.4.0 added +463 B), 73 B
 * under budget. Four cuts brought it to 63,995 B — 1,505 B of headroom: the Flight soft-nav
 * runtime and the root-less islands mount moved to flight-nav.ts, which only the Flight entry's
 * `setFlightParser` reaches (−394 B, −131 B); the class base (`Component`/`PureComponent`) left
 * this graph for the class-runtime chunk once the server renderer imported only
 * class-instance.ts (−497 B); the dev-only prop warnings moved behind `installDevtools`
 * (−375 B); and two pieces of module-scope residue went (−35 B). Each gate is asserted in
 * {@link assertGatedRuntimeAbsent}.
 * Re-based 65.5 → 68.5 KB (68,500 B) for root event delegation (React 17+'s model,
 * fiber/events.ts): the dispatcher, its capture/bubble ordering, portal and nested-root
 * ownership, focusin/focusout and the derived enter/leave events are +3.9 KB raw (measured
 * 67,915 B, from 64,039 B). An approved trade: a bubbling handler no longer costs a listener and
 * a closure per element, re-registered on every render that passes a new function.
 * Re-based 68.5 → 67.4 KB (67,400 B) after recovering 2,043 B with no change in behaviour
 * (measured 65,872 B, ~1.5 KB of headroom): the SuspenseList reveal runtime (−778 B) and the
 * Profiler commit runtime (−238 B) ride their elements' marker props, so they ship only with
 * `SuspenseList` / `Profiler`; the hydration-mismatch warning and the async-transition watchdog
 * moved behind `installDevtools` (−636 B); `use()`'s DENEXT_DEBUG_SUSPENSE origin trace is
 * installed by the server's request pipeline (−146 B); and three duplicated helpers merged
 * (control-signal predicates −99 B, the soft-nav JSON-island writers −181 B, the singleton
 * runtime's host-update completion +35 B).
 * Re-based 67.4 → 67.1 KB (67,100 B) after recovering 1,795 B with no change in behaviour,
 * once root touch/wheel delegation (67,385 B, 15 B under the old budget) had used up the
 * headroom (measured 65,590 B, ~1.5 KB of headroom): dev Fast Refresh's per-render swap
 * resolution and the per-module root refresh are installed by `enableFastRefresh`
 * (refresh-swap.ts, −674 B); the reconciler's long error texts became codes whose full text
 * `installDevtools` and `denext/testing` install (errors.ts / error-texts.ts, −469 B); the
 * fiber extension's fields are listed once, for its shape and for the twin carry (−338 B);
 * and the AsyncContext `Variable` ships only in an `asyncContext` build, whose mode module now
 * exports it (−306 B). Each gate is asserted in {@link assertGatedRuntimeAbsent}.
 * StrictMode's dev double-invoke and the `useDebugValue` recorder then moved behind
 * `installDevtools` too (dev-render.ts, −237 B: 65,590 → 65,353 B), with no budget change.
 * Re-based 67.1 → 65.5 KB (65,500 B) after recovering 2,691 B with no change in behaviour, once
 * the conditional-slot matching, Activity's class lifecycles and refs, root-level suspension and
 * isomorphic-island hydration (67,032 B, 68 B under the old budget) had used up the headroom
 * (measured 64,341 B, ~1.2 KB of headroom): the soft-navigation commit — the view-transition
 * wrapper, history, scroll, the data-island writes and the isomorphic / full-HTML paths — moved to
 * nav-document.ts, an on-demand `nav-document-*` chunk that a prefetch warms and a navigation
 * loads alongside its route fetch, with the state it shares in the leaf nav-state.ts (−2,491 B);
 * the class-runtime-unavailable error became reconciler code 5, its full text installed with the
 * others (−166 B); and the SVG namespace is one constant (−32 B). Each gate is asserted in
 * {@link assertGatedRuntimeAbsent}.
 * A hydrated `dangerouslySetInnerHTML` mismatch is then kept, as React 19 keeps it: the `__html`
 * comparison rides the dev hydration warning and production neither compares nor patches
 * (−160 B: 64,770 → 64,610 B, Deno 2.9.7), with no budget change.
 * React 19.3's Fragment refs then added the reconciler's seam and its load-on-first-use (+420 B:
 * 64,610 → 65,030 B), with no budget change: the FragmentInstance itself is the on-demand
 * `fragment-instance-*` chunk, which imports no shared module (one that did split this graph into
 * more chunks, +2.5 KB). Its gate is asserted in {@link assertGatedRuntimeAbsent}.
 * Inline Suspense boundaries in the shell (hydration passing over `<!--$-->` markers and
 * unwrapping a streamed boundary's placeholder, +289 B) and hydrating react-dom/server's
 * `<!--$!-->` client-rendered boundaries (+461 B) then took it to 65,780 B, over budget. Only
 * react-dom/server's synchronous `renderToString` writes a `<!--$!-->` boundary, so that
 * hydration moved to suspense-hydration.ts, which the compat `react-dom/client` / `react-dom`
 * modules install; its gate is asserted in {@link assertGatedRuntimeAbsent}.
 * Re-based 65.5 → 67 KB (67,000 B) on 2026-10-20, the maintainer's decision, with a standing
 * order: the budget is the backstop, and the real guard is that nothing the app never calls is
 * compiled in. The shared graph stood at 65,447 B (53 B of headroom). A per-module audit of it
 * (plans/bundle-dead-code.md) then cut 598 B with no change in behaviour (measured 64,849 B,
 * 2,151 B under the new budget): a function-valued form action's submit work (FormData, the
 * call, `useFormStatus`) is the on-demand `form-action-*` chunk, loaded by the first such form
 * (−360 B), and the class runtime's constructor left the shared graph, where the server
 * renderer's file had hoisted it (−238 B). The same audit took the class runtime and the lazy
 * hydration scheduler out of every Flight app's startup graph (examples/islands: 76,244 →
 * 68,936 B). Each gate is asserted in {@link assertGatedRuntimeAbsent} and, for the Flight
 * startup graph, {@link assertFlightStartupLean}; `bundle-features` proves each one still ships
 * when the app uses it.
 * Re-based 67 → 65 KB (65,000 B) on 2026-10-21 after round 2 of that audit cut 1,516 B with no
 * change in behaviour (measured 63,378 B, 1,622 B under the new budget): the optional hooks
 * (`useReducer`, `useId`, `useSyncExternalStore`, `useDeferredValue`, `useMemoCache`,
 * `useInsertionEffect`, `useEffectEvent`) left the client dispatcher object for modules of their
 * own, which reach the reconciler only through the dispatcher's host members, and the transition
 * engine left the scheduler for the transition hooks' module, which drives it through the
 * scheduler's `TransitionHost`. The Server Action dispatch and the wire encoder left every Flight
 * app's startup graph too (examples/islands: 68,980 → 65,447 B in all). Each gate is asserted in
 * {@link assertGatedRuntimeAbsent} and {@link assertFlightStartupLean}.
 * Re-based 65 → 64.5 KB (64,500 B) on 2026-10-22 after round 3 of that audit: where `deno bundle`
 * takes `--define` (denext's Deno toolchain), the build defines two build-scan gates off for an app
 * whose sources never name the feature, so the boot's `next/image` blur-placeholder clearing and
 * the reconciler's function-valued form-action seam fold out (measured 62,954 → 62,003 B). A stock
 * Deno keeps both behind a runtime check (63,378 → 63,563 B, 937 B under the new budget; a local
 * `deno task budget` on a stock `deno` measures that). A chunk no page can load is no longer emitted. Each gate is asserted in
 * {@link assertGatedRuntimeAbsent} and {@link assertFlightStartupLean} (define path), and the
 * bundle-features fixture proves both still ship when used.
 * Raised 64,500 → 64,600 B on 2026-10-28 (measured 64,577 B): the reconciler cancels the passive-
 * effect flush macrotask a sooner flush made moot, and closes its time-slicing MessageChannel once
 * slicing goes idle, so neither outlives the work (the leak fixes the op / resource sanitizers
 * found; trimmed to 77 B over the old budget).
 */
async function assertBundleBudgets(clientDir: string): Promise<void> {
  let sharedTotal = 0;
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && /^chunk-.*\.js$/.test(e.name)) {
      sharedTotal += (await Deno.stat(join(clientDir, e.name))).size;
    }
  }
  assert(sharedTotal < SHARED_BUDGET, budgetMessage(sharedTotal));
  for (const f of ["about.js", "blog___slug_.js"]) {
    const n = (await Deno.stat(join(clientDir, f))).size;
    assert(n < 6_000, `${f} is ${n} bytes (budget 6 KB) — is the runtime inlined again?`);
  }
}

/** The shared-chunk budget for examples/hello, in raw bytes (its history is in the comment above). */
const SHARED_BUDGET = 64_600;

/** The over-budget message: how far over, how to reproduce it, and the two ways out. */
function budgetMessage(total: number): string {
  return `shared chunks total ${total} bytes (budget ${SHARED_BUDGET} B raw: ${
    total - SHARED_BUDGET + 1
  } B over).\n` +
    "Reproduce locally: deno task budget. See what grew: deno run -A cli.ts analyze examples/hello --md " +
    "(it builds first).\n" +
    "Fix: load the new code on first use (assertGatedRuntimeAbsent lists the gates) or cut that " +
    "many bytes elsewhere; raise SHARED_BUDGET only with a dated note above assertBundleBudgets " +
    "saying what the bytes buy.";
}

/**
 * The import-gate tripwire: a function-only app's shared runtime chunk must not carry any of
 * the gated optional subsystems. These string/property markers survive minification (unlike
 * the mangled function names), so their absence proves the gate held — a stronger check than
 * the byte budget. If a static import ever re-couples one of these into the reconciler core,
 * the marker reappears and this trips loudly.
 */
async function assertGatedRuntimeAbsent(clientDir: string): Promise<void> {
  const gated: Array<[string, string]> = [
    ["componentDidMount", "class-component runtime"], // class lifecycle (Gate A)
    ["getDerivedStateFromError", "class-component error boundaries"], // (Gate A)
    ["__REACT_DEVTOOLS_GLOBAL_HOOK__", "React-DevTools bridge"], // (Gate B)
    ["__denext_ge_data", "global-error client"], // per-route entries never carry it (Gate C)
    ["view-transition-name:", "ViewTransition marking runtime"], // (WS3 gate)
    ["two children with the same key", "dev-only duplicate-key warning"], // installDevtools only
    ["dnx-reveal:", "inline streaming swap runtime (a server string)"], // pure-built SWAP_RUNTIME
    ["data-vl-", "VirtualList (0 bytes unless imported)"], // the list's row attributes
    ["trailingMargin", "VirtualList controller's axis tables"], // module-scope objects
    ["data-dnx-swipe-row", "SwipeableRow (0 bytes unless imported)"],
    ["__dnxIdx", "denext/navigation's history sources"],
    // The Flight soft-nav commit (flight-nav.ts) reads the payload's `signalState`: only the
    // Flight entry's `setFlightParser` installs it, so an app with no Flight route ships none.
    ["signalState", "Flight soft-navigation runtime"],
    // The class base (`Component`/`PureComponent`) belongs to the on-demand class runtime; the
    // server renderer's static import of it once hoisted it into this shared graph.
    ["class component is missing a render", "class-component base classes"],
    // Dev-only prop warnings ride `installDevtools` (dom-props.ts's warning seam).
    ["emits raw HTML", "dev-only dangerouslySetInnerHTML warning"],
    ["refused a dangerous URL", "dev-only dangerous-URL warning"],
    // More dev-only diagnostics on `installDevtools` (hydration.ts's and scheduler.ts's seams).
    ["hydration mismatch", "dev-only hydration-mismatch warning"],
    ["async transition has been pending", "dev-only async-transition watchdog"],
    // The server's request pipeline installs `use()`'s origin trace; no client reads it.
    ["use() suspended here", "server-only DENEXT_DEBUG_SUSPENSE origin trace"],
    // Carried by the `SuspenseList` / `Profiler` elements' marker props: 0 bytes unless used.
    ["collapsed", "SuspenseList reveal runtime"],
    ["onRender", "Profiler commit runtime"],
    // The reconciler's full error texts ride `installDevtools` / `denext/testing` (errors.ts);
    // a production bundle throws the codes.
    ["Rendered more hooks", "reconciler error texts"],
    ["Maximum update depth", "reconciler error texts"],
    // Dev Fast Refresh's per-render swap resolution, installed by `enableFastRefresh`.
    ["oldKinds", "dev Fast Refresh swap resolution"],
    // The AsyncContext `Variable` ships only in an `asyncContext` build (async-context-mode.ts).
    ['"defaultValue"in', "AsyncContext Variable"],
    // StrictMode's dev double-invoke (its boundary marker check) rides `installDevtools`.
    ["__dnxStrict", "StrictMode dev double-invoke"],
    // The soft-navigation commit is the on-demand nav-document chunk, loaded by a navigation.
    ["startViewTransition", "soft-nav view-transition wrapper (nav-document.ts)"],
    ["data-dnx-css", "isomorphic soft-nav stylesheet swap (nav-document.ts)"],
    ["DOMParser", "full-HTML soft navigation (nav-document.ts)"],
    // The class-runtime-unavailable text is reconciler code 5's full text (errors.ts).
    ["class components are disabled", "reconciler error texts"],
    // `<Script strategy="worker">`'s Partytown markup rides <Script> (0 bytes unless imported).
    ["text/partytown", "the Script worker strategy"],
    // React 19.3's FragmentInstance is the on-demand fragment-instance chunk, loaded by the first
    // `<Fragment ref>` a render reaches (fragment-ref-support.ts).
    ["reactFragments", "Fragment-ref runtime (fragment-instance.ts)"],
    ["observeUsing", "Fragment-ref runtime (fragment-instance.ts)"],
    // Hydrating react-dom/server's `<!--$!-->` boundaries ships with the compat react-dom modules.
    ['"$!"', "client-rendered boundary hydration (suspense-hydration.ts)"],
    // The optional hooks left the client dispatcher object for their own modules (an object keeps
    // every method; a module's unused function is dropped). A method of that name on the
    // dispatcher again would carry its code into every app.
    ["useReducer", "client dispatcher's useReducer method (client/fiber/hooks/use-reducer.ts)"],
    ["useId", "client dispatcher's useId method (client/fiber/hooks/use-id.ts)"],
    [
      "useSyncExternalStore",
      "client dispatcher's useSyncExternalStore method (client/fiber/hooks/use-sync-external-store.ts)",
    ],
    [
      "useDeferredValue",
      "client dispatcher's useDeferredValue method (client/fiber/hooks/use-deferred-value.ts)",
    ],
    [
      "useMemoCache",
      "client dispatcher's useMemoCache method (client/fiber/hooks/use-memo-cache.ts)",
    ],
    [
      "useInsertionEffect",
      "client dispatcher's useInsertionEffect method (client/fiber/hooks/use-insertion-effect.ts)",
    ],
    // The feature runtimes below ship only when the app uses the feature; each one's positive
    // half is FEATURE_MARKERS, asserted against the bundle-features fixture.
    ...FEATURE_MARKERS.map(({ marker, what }): [string, string] => [marker, what]),
    // The build-scan defines fold their runtime out only where `deno bundle` takes `--define`
    // (denext's Deno toolchain); a stock Deno keeps it on.
    ...(await bundleSupportsDefine() ? SCAN_GATE_MARKERS : []).map((
      { marker, what },
    ): [string, string] => [marker, what]),
  ];
  let shared = "";
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && /^chunk-.*\.js$/.test(e.name)) {
      shared += await Deno.readTextFile(join(clientDir, e.name));
    }
  }
  for (const [marker, what] of gated) {
    assert(
      !shared.includes(marker),
      `shared chunk contains "${marker}" — the ${what} leaked back into the function-only ` +
        `runtime (an import-gate regressed)`,
    );
  }
}

/**
 * Feature runtimes that must be ABSENT from a minimal app's shared chunks (examples/hello uses
 * none of them) and PRESENT in the client output of an app that uses them
 * (tests/fixtures/bundle-features uses each once). Each marker is a string that survives
 * minification and appears only in that feature's code. A miss in hello means a static import
 * re-coupled the feature to the core; a miss in the fixture means the gate dropped a feature an
 * app needs.
 */
const FEATURE_MARKERS: ReadonlyArray<{ marker: string; what: string }> = [
  // A function-valued `<form action>`'s submit: the on-demand form-action chunk.
  { marker: "globalThis.FormData", what: "form-action submit runtime (form-action.ts)" },
  // Isomorphic `client:*` islands: `denext/iso-island`, imported only for a directive.
  { marker: "display:contents", what: "isomorphic island runtime (iso-island.ts)" },
  // Flight `client:*` islands: `denext/lazy`, loaded by a page with lazy islands.
  { marker: "data-dnx-hydrated", what: "lazy island boot (lazy-boot.ts)" },
  { marker: "qrl handler failed", what: "resumable event dispatcher (qrl-dispatch.ts)" },
  // A Server Action call from the browser.
  { marker: "x-denext-action", what: "Server Action dispatch (client/action-dispatch.ts)" },
  // Model–View–Update: `denext/mvu`.
  { marker: "too many pending effects", what: "MVU runtime (runtime/mvu.ts)" },
  // The wire codec (Flight values, actions, Live): Flight and Live apps only.
  { marker: "denext.wire.notTagged", what: "wire codec (wire-codec.ts)" },
  // Live: the socket transport and the channel protocol.
  { marker: "channel-unsubscribe", what: "Live client (live-client.ts)" },
  // The Flight client (payload parser + soft navigation).
  { marker: "__denext_flight", what: "Flight client runtime" },
  // The wire encoder: its own file (wire-encode.ts), so a page that only decodes never carries it.
  { marker: "value too deep", what: "wire encoder (wire-encode.ts)" },
  // The hooks whose client implementation is its own module (src/client/fiber/hooks/), each
  // marked by its call into the dispatcher's host members (a property name survives minification;
  // the host object itself, in every app, defines them without a call).
  { marker: ".reducer(", what: "useReducer (client/fiber/hooks/use-reducer.ts)" },
  { marker: ".fiber().idScope", what: "useId (client/fiber/hooks/use-id.ts)" },
  {
    marker: ".storeUpdate(",
    what: "useSyncExternalStore (client/fiber/hooks/use-sync-external-store.ts)",
  },
  { marker: ".deferUpdate(", what: "useDeferredValue (client/fiber/hooks/use-deferred-value.ts)" },
  {
    marker: ".insertion(",
    what: "useInsertionEffect (client/fiber/hooks/use-insertion-effect.ts)",
  },
  {
    marker: "react.memo_cache_sentinel",
    what: "useMemoCache (client/fiber/hooks/use-memo-cache.ts)",
  },
  { marker: "useEffectEvent can't", what: "useEffectEvent (runtime/hooks/use-effect-event.ts)" },
  // The transition engine (startTransition / useTransition / useOptimistic) and useActionState.
  { marker: ".beginAsync(", what: "transition engine (runtime/hooks/transition.ts)" },
  { marker: ".denextPermalink=", what: "useActionState (runtime/actions.ts)" },
];

/**
 * Runtimes a build-scan `define` folds out of an app that never writes the feature (see
 * src/globals.d.ts): absent from hello's shared chunks and the Flight startup graph when the
 * running `deno bundle` takes `--define`, present in the bundle-features fixture on every path.
 */
const SCAN_GATE_MARKERS: ReadonlyArray<{ marker: string; what: string }> = [
  // The client boot clears `next/image` blur placeholders in server-only trees (navigation.ts).
  { marker: 'tagName==="IMG"', what: "blur-placeholder clearing (navigation.ts)" },
  // A function-valued `<form action>` loads the form-action chunk from the reconciler's seam.
  { marker: "./form-action-", what: "form-action seam (dom-props.ts setFormAction)" },
  // A `{ pathname: "/blog/[slug]", params }` href is filled through the route-segment parser.
  { marker: '"optionalCatchAll"', what: "route-pattern href filling (router/segments.ts)" },
];

/**
 * Every emitted file a page can load: a route entry (an unhashed name) or a file another one
 * names (`import`, `import()`, `new URL`). A chunk whose only `import()` site was tree-shaken
 * after code splitting placed it is not written (the bundle's `pruneUnreachable`).
 */
async function assertNoUnloadedChunks(clientDir: string): Promise<void> {
  const files = (await fileNames(clientDir)).filter((f) => f.endsWith(".js"));
  let all = "";
  for (const f of files) all += await Deno.readTextFile(join(clientDir, f));
  for (const f of files.filter((f) => /-[A-Z0-9]{8}\.js$/.test(f))) {
    assert(all.includes(`./${f}`), `${f} is emitted but no client file loads it`);
  }
}

Deno.test("build smoke: examples/hello emits a client entry, a code-split island chunk, and a shared chunk", async () => {
  // A private copy: the build writes its `.denext/`, which other test files must not race.
  const result = await build(await copyExample("hello"));
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
  // The build id that keys this build's cached pages (a redeploy never reads another's).
  assert(
    typeof manifest.buildId === "string" && manifest.buildId.length > 0,
    "manifest records a build id",
  );

  // The entry wires up hydration against the server-rendered root.
  const entry = await Deno.readTextFile(join(clientDir, "index.js"));
  assertStringIncludes(entry, "__denext");

  await assertNoRefreshRuntime(clientDir, files);
  await assertNoNodeBuiltins(clientDir, files);
  await assertSharedRuntimeChunk(clientDir);
  await assertBundleBudgets(clientDir);
  await assertGatedRuntimeAbsent(clientDir);
  await assertNoUnloadedChunks(clientDir);
});

// The other half of the Flight soft-nav gate: an app WITH Flight routes still ships the
// soft-nav runtime (the `signalState` marker its commit reads), reached from `flight.js`.
Deno.test("build smoke: a Flight app (examples/islands) ships the Flight soft-navigation runtime", async () => {
  // The native path's per-module attribution (`denext analyze --md`'s), for the hoist check.
  const prior = Deno.env.get("DENEXT_ANALYZE");
  Deno.env.set("DENEXT_ANALYZE", "1");
  // A private copy: the build writes its `.denext/`, which other test files must not race.
  const app = await copyExample("islands");
  const result = await build(app).finally(() => {
    if (prior === undefined) Deno.env.delete("DENEXT_ANALYZE");
    else Deno.env.set("DENEXT_ANALYZE", prior);
  });
  const clientDir = join(result.outDir, "client");
  let flightGraph = "";
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && /^(flight|chunk-.*)\.js$/.test(e.name)) {
      flightGraph += await Deno.readTextFile(join(clientDir, e.name));
    }
  }
  assertStringIncludes(
    flightGraph,
    "signalState",
    "the Flight soft-nav runtime is missing from a Flight app",
  );
  await assertFlightStartupLean(clientDir);
  await assertNoUnloadedChunks(clientDir);
  await assertNoLazyModuleHoisted(clientDir, app);
});

/**
 * Framework modules that only ever load on demand (an `import()` reaches them): in a Flight app
 * that uses none of them up front, none may have a byte in the startup graph. The bundler places
 * code by FILE, so a static edge from any startup module, even an unused re-export, hoists a
 * lazily used module's code into a chunk every page loads (plans: the systemic finding). Read
 * from the build's source maps (`denext analyze --md`'s native attribution).
 */
const LAZY_ONLY_MODULES: readonly string[] = [
  "src/client/lazy-hydrate.ts", // the lazy-* chunk (client:* scheduling)
  "src/client/lazy-boot.ts",
  "src/client/qrl-dispatch.ts",
  "src/client/iso-island.ts", // route entries with a client:* directive only
  "src/compat/class-component.ts", // the class-runtime-* chunk
  "src/compat/class-base.ts",
  "src/class-runtime.ts",
  "src/client/form-action.ts", // the form-action-* chunk
  "src/client/action-call.ts", // the action-call-* / action-dispatch-* chunks
  "src/client/action-dispatch.ts",
  "src/runtime/wire-encode.ts",
  "src/client/nav-document.ts", // the nav-document-* chunk (a soft navigation)
  "src/client/flight-nav-stream.ts",
  "src/jsx/flight-value-holes.ts",
  "src/client/fiber/fragment-instance.ts", // the fragment-instance-* chunk
  "src/mobile/momentum-scroll.ts", // the momentum-scroll-* chunk (iOS WebKit only)
];

/** No {@link LAZY_ONLY_MODULES} code in examples/islands' startup graph (`app`: its build's copy). */
async function assertNoLazyModuleHoisted(clientDir: string, app: string): Promise<void> {
  // Real paths: the attribution resolves each source map entry through symlinks (macOS `/var`).
  const meta = await nativeAnalyzeMeta(
    clientDir,
    await Deno.realPath(app),
    await Deno.realPath(frameworkRoot()),
  );
  assert(meta, "the build recorded no per-module attribution (DENEXT_ANALYZE=1)");
  const startup = await startupFiles(clientDir, ["__denext_flight__.js"]);
  for (const file of startup) {
    const inputs = meta.outputs[file]?.inputs ?? {};
    for (const module of LAZY_ONLY_MODULES) {
      const bytes = inputs[`denext/${module}`]?.bytesInOutput ?? 0;
      assertEquals(bytes, 0, `${module} has ${bytes} B in the startup chunk ${file} (hoisted)`);
    }
  }
  // The detector sees modules at all: the lazy chunk carries the scheduler.
  const lazy = Object.entries(meta.outputs).find(([name]) => name.startsWith("lazy-"));
  assert(lazy && lazy[1].inputs["denext/src/client/lazy-hydrate.ts"], "lazy-hydrate.ts attributed");
}

/** Each shared chunk's byte size, sorted (chunk names are content hashes, so they match too). */
async function sharedChunkSizes(clientDir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && /^chunk-.*\.js$/.test(e.name)) {
      out.push(`${e.name} ${(await Deno.stat(join(clientDir, e.name))).size}`);
    }
  }
  return out.sort();
}

/**
 * A temp dir with a symlink `link` → `target`; on Windows a junction (a symlink needs Developer
 * Mode or a privilege). A host that can't make one ignores these tests (`IGNORE_WITHOUT_DIR_LINKS`).
 */
async function tempSymlink(target: string): Promise<{ dir: string; link: string }> {
  const dir = await Deno.makeTempDir({ prefix: "denext-build-symlink-" });
  const link = join(dir, "link");
  try {
    await symlinkDir(target, link);
    return { dir, link };
  } catch (err) {
    await Deno.remove(dir, { recursive: true });
    throw err;
  }
}

// A project reached through a symlink (macOS's `/var` → `/private/var` puts every `$TMPDIR`
// project behind one; a symlinked home or workspace folder too) builds what its real path does.
// Deno resolves the app's imports from the real location of its deno.json, so a symlinked spelling
// of the project once reached the JSX runtime under two paths and bundled it twice (+450 B).
Deno.test({
  name: dirLinkTestName(
    "build smoke: examples/hello built through a symlink matches its real-path build",
  ),
  ignore: IGNORE_WITHOUT_DIR_LINKS,
}, async () => {
  const real = await sharedChunkSizes(join((await build(EXAMPLE)).outDir, "client"));
  const made = await tempSymlink(fromFileUrl(new URL("../..", import.meta.url)));
  try {
    const result = await build(join(made.link, "examples", "hello"));
    const clientDir = join(result.outDir, "client");
    assertEquals(await sharedChunkSizes(clientDir), real);
    await assertGatedRuntimeAbsent(clientDir);
  } finally {
    await Deno.remove(made.dir, { recursive: true });
  }
});

// An app whose import map names the framework checkout through a symlink: the crawl's framework
// modules then carry the symlinked spelling while the framework's own URL is the real path, and a
// prefix test between the two put the whole framework "outside" the app. Every build-time feature
// scan then read the framework's sources and matched, installing every gated runtime (the class,
// Activity, ViewTransition, singleton and iso-island runtimes: +5.5 KB over hello's shared graph).
Deno.test({
  name: dirLinkTestName(
    "build smoke: an app that maps denext through a symlink installs no unused runtime",
  ),
  ignore: IGNORE_WITHOUT_DIR_LINKS,
}, async () => {
  const made = await tempSymlink(fromFileUrl(new URL("../..", import.meta.url)));
  try {
    const app = join(made.dir, "app");
    await Deno.mkdir(app);
    for (const entry of ["app", "public", "middleware.ts"]) {
      await copy(join(EXAMPLE, entry), join(app, entry));
    }
    const config = JSON.parse(await Deno.readTextFile(join(EXAMPLE, "deno.json")));
    delete config.lint;
    delete config.tasks;
    for (const [k, v] of Object.entries(config.imports as Record<string, string>)) {
      // A URL, as an import map takes it (a Windows `C:\\…` path is not one).
      config.imports[k] = toFileUrl(join(made.link, v.replace(/^\.\.\/\.\.\//, ""))).href;
    }
    await Deno.writeTextFile(join(app, "deno.json"), JSON.stringify(config));
    const clientDir = join((await build(app)).outDir, "client");
    await assertGatedRuntimeAbsent(clientDir);
    assertBelowBudget(await sharedChunkSizes(clientDir));
  } finally {
    await Deno.remove(made.dir, { recursive: true });
  }
});

/** The shared-chunk total of `sizes` (from {@linkcode sharedChunkSizes}) is under budget. */
function assertBelowBudget(sizes: string[]): void {
  const total = sizes.reduce((n, s) => n + Number(s.split(" ")[1]), 0);
  assert(total < SHARED_BUDGET, budgetMessage(total));
}

/**
 * The files a page loads before any of its code runs: `entries` and, transitively, every chunk
 * they import statically (a dynamic `import()` is not followed). Returns their concatenated text.
 */
async function startupGraph(clientDir: string, entries: string[]): Promise<string> {
  let text = "";
  for (const file of await startupFiles(clientDir, entries)) {
    text += await Deno.readTextFile(join(clientDir, file));
  }
  return text;
}

/** The names of {@linkcode startupGraph}'s files. */
async function startupFiles(clientDir: string, entries: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = await Deno.readTextFile(join(clientDir, file));
    for (const m of src.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) queue.push(m[1]);
  }
  return seen;
}

/**
 * The startup half of the import gates on a Flight app. The bundler places code by FILE: a module
 * the startup graph reaches through ANY static import, even an unused re-export, and a lazily
 * loaded chunk also uses ships in a chunk every page loads. examples/islands has lazy `client:*`
 * islands (its lazy chunk legitimately carries the scheduler) and no class component, form
 * action or isomorphic island, so none of those runtimes may be in its startup graph.
 */
async function assertFlightStartupLean(clientDir: string): Promise<void> {
  const startup = await startupGraph(clientDir, ["__denext_flight__.js"]);
  const absent: Array<[string, string]> = [
    // Hoisted out of `denext/lazy` by the client-runtime barrel's iso-island re-export once.
    [
      "requestIdleCallback",
      "lazy island scheduler (lazy-hydrate.ts; it belongs to the lazy-* chunk)",
    ],
    ["qrl handler failed", "resumable event dispatcher (qrl-dispatch.ts; the lazy-* chunk's)"],
    // Installed eagerly once because the page's comment said "Server Component".
    ["componentDidMount", "class-component runtime (it belongs to the class-runtime-* chunk)"],
    ["display:contents", "isomorphic island runtime"],
    ["globalThis.FormData", "form-action submit runtime (it belongs to the form-action-* chunk)"],
    // A Server Action reference's call: the on-demand action-call / action-dispatch chunks.
    ["x-denext-action", "Server Action dispatch (it belongs to the action-dispatch-* chunk)"],
    ["value too deep", "wire encoder (only the on-demand action-call chunk uses it here)"],
    // The split-out hooks and the transition engine: examples/islands' startup calls none.
    ...FEATURE_MARKERS.filter(({ marker }) => HOOK_MARKERS.has(marker)).map((
      { marker, what },
    ): [string, string] => [marker, what]),
    // examples/islands renders no blur placeholder and no form action (build-scan defines).
    ...(await bundleSupportsDefine() ? SCAN_GATE_MARKERS : []).map((
      { marker, what },
    ): [string, string] => [marker, what]),
  ];
  for (const [marker, what] of absent) {
    assert(
      !startup.includes(marker),
      `the Flight startup graph contains "${marker}" — the ${what}`,
    );
  }
}

/** The FEATURE_MARKERS of the split-out hooks and the transition engine. */
const HOOK_MARKERS: ReadonlySet<string> = new Set([
  ".reducer(",
  ".fiber().idScope",
  ".storeUpdate(",
  ".deferUpdate(",
  ".insertion(",
  "react.memo_cache_sentinel",
  "useEffectEvent can't",
  ".beginAsync(",
  ".denextPermalink=",
]);

const FEATURES_FIXTURE = fromFileUrl(
  new URL("../fixtures/bundle-features", import.meta.url),
);

// The positive half of FEATURE_MARKERS: an app that uses each gated feature ships its runtime.
// One build, one step per feature.
Deno.test("build smoke: an app that uses each gated feature ships its runtime", async (t) => {
  const result = await build(FEATURES_FIXTURE);
  const clientDir = join(result.outDir, "client");
  let all = "";
  for await (const e of Deno.readDir(clientDir)) {
    if (e.isFile && e.name.endsWith(".js")) all += await Deno.readTextFile(join(clientDir, e.name));
  }
  for (const { marker, what } of [...FEATURE_MARKERS, ...SCAN_GATE_MARKERS]) {
    await t.step(what, () => {
      assert(all.includes(marker), `the ${what} is missing ("${marker}") from an app that uses it`);
    });
  }
  // The Flight page has Server Actions (an island imports one, another is handed one as a prop),
  // yet its startup graph carries no dispatch: the action-call chunk loads on the first reference.
  // (The wire encoder is in this page's startup: its Live client sends codec frames.)
  await t.step("Server Action dispatch loads on demand on a Flight page with actions", async () => {
    const startup = await startupGraph(clientDir, ["__denext_flight__.js"]);
    assert(!startup.includes("x-denext-action"), "the Flight startup graph carries the dispatch");
    const files = await fileNames(clientDir);
    assert(
      files.some((f) => f.startsWith("action-call-")),
      `expected an action-call-*.js chunk; got: ${files.join(", ")}`,
    );
  });
  // The page names a class component, so the build's preload hint installs the class runtime
  // in the route's startup graph instead of loading it on demand.
  await t.step("class-component runtime, eager when the app names a class", async () => {
    const startup = await startupGraph(clientDir, ["index.js"]);
    assertStringIncludes(startup, "componentDidMount");
  });
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

    const out = await boundedOutput(Deno.execPath(), {
      args: ["eval", code],
    });
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

    const out = await boundedOutput(Deno.execPath(), {
      args: ["eval", code],
    });
    const text = new TextDecoder().decode(out.stdout);
    assertStringIncludes(text, "first=failed second=ok");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
