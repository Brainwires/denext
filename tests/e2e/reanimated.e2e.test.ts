// Real-browser E2E for Reanimated in React Native mode WITHOUT its Babel plugin: the real
// react-native-reanimated 4 / react-native-worklets / react-native-gesture-handler web builds,
// with denext's worklets pass (src/build/reanimated.ts) stamping `__closure` /
// `__workletHash` on the app's worklets and the libraries' own. The fixture writes every
// worklet the Metro way (no dependency arrays, no directives on hook callbacks), and this
// test proves in headless Chromium, on both the dev server (where `__DEV__` is on and
// `useAnimatedStyle` without a closure or dependency array throws) and a production build:
//   1. the app renders with no console errors (no dev throw);
//   2. `withTiming` / `withSpring` drive `useAnimatedStyle` / `useDerivedValue`, and
//      `useAnimatedReaction` + `runOnJS` reach React state;
//   3. a worklet that captures React state re-runs when that state changes (the closure is
//      the dependency list);
//   4. `useAnimatedScrollHandler` follows the scroll offset;
//   5. a gesture-handler `Gesture.Pan()` worklet callback moves the view under the mouse;
//   6. the compositor pass (src/build/reanimated-offload.ts): a shared value animated into
//      transform / opacity, a style-returned animation, a `withSequence`, a forever `withRepeat`
//      and a `FadeIn` entering animation run as Web Animations — and the shared-value one and the
//      entering one keep producing frames while the main thread is blocked for 500 ms (CDP
//      screencast frames, which the compositor draws; with nothing animating there are none,
//      and the same animation on Reanimated's own loop — the pass turned off — draws none
//      either) — and `LayoutAnimation.configureNext` animates the views a commit moves.
//
// The fixture is copied to a temp dir outside the workspace (like spa-compat) and its npm
// packages installed there (`npm install`, NETWORK-REQUIRED; skipped when npm or the network
// is unavailable). Opt-in: `deno task test:e2e`.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join } from "@std/path";
import type { Page } from "@astral/astral";
import {
  buildAndServe,
  launchBrowser,
  pollFor,
  type RunningServer,
  startSpaDevOnDir,
} from "./harness.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url)); // repo root
const FIXTURE = fromFileUrl(new URL("./fixtures/reanimated", import.meta.url));
const INSTALL_TIMEOUT_MS = 240_000;

/** Materialize the fixture in a temp dir and install its npm packages; null when offline. */
async function setup(): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: "denext_reanimated_" });
  await copy(join(FIXTURE, "src"), join(dir, "src"));
  await copy(join(FIXTURE, "denext.config.ts"), join(dir, "denext.config.ts"));
  await copy(join(FIXTURE, "package.json"), join(dir, "package.json"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(
      {
        nodeModulesDir: "manual",
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "react",
          lib: ["deno.window", "dom", "dom.iterable"],
        },
        imports: {
          "react": `${FW}src/compat/react.ts`,
          "react-dom": `${FW}src/compat/react-dom.ts`,
          "react-dom/client": `${FW}src/compat/react-dom-client.ts`,
          "react/jsx-runtime": `${FW}src/jsx/jsx-runtime.ts`,
          "react/jsx-dev-runtime": `${FW}src/jsx/jsx-runtime.ts`,
          "denext": `${FW}mod.ts`,
          "denext/": `${FW}src/`,
          "denext/server": `${FW}src/server/mod.ts`,
          "denext/client": `${FW}src/client/mod.ts`,
        },
      },
      null,
      2,
    ),
  );
  try {
    // --legacy-peer-deps: reanimated / worklets peer on `react-native`, which RN mode never
    // loads (react-native-web stands in for it).
    const out = await new Deno.Command("npm", {
      args: ["install", "--no-audit", "--no-fund", "--no-package-lock", "--legacy-peer-deps"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
    }).output();
    if (out.success) return dir;
    console.warn("e2e: npm install failed — skipping.\n" + new TextDecoder().decode(out.stderr));
  } catch (e) {
    console.warn(`e2e: npm install unavailable (${e}) — skipping.`);
  }
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  return null;
}

/** `[data-testid=<id>]` in the page. */
const el = (id: string) => `document.querySelector('[data-testid="${id}"]')`;
/** A computed style property of the test element `id`. */
const style = (id: string, prop: string) => `getComputedStyle(${el(id)}).${prop}`;
/** The x translation of the test element `id`'s computed transform (0 when none). */
const translateX = (id: string) =>
  `(new DOMMatrixReadOnly(getComputedStyle(${
    el(id)
  }).transform === "none" ? undefined : getComputedStyle(${el(id)}).transform)).m41`;

/** The client entry and every chunk it reaches (dev splits the app into chunks). */
async function clientBundle(origin: string): Promise<string> {
  const seen = new Set<string>();
  const queue = ["/_denext/client/index.js"];
  let all = "";
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const js = await (await fetch(origin + path)).text();
    all += js;
    for (const m of js.matchAll(/["'](\/_denext\/client\/[\w.-]+\.js|\.\/[\w.-]+\.js)["']/g)) {
      queue.push(m[1].startsWith("./") ? "/_denext/client/" + m[1].slice(2) : m[1]);
    }
  }
  return all;
}

/** Collect console errors and uncaught page errors. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.addEventListener("console", (e) => {
    // deno-lint-ignore no-explicit-any
    const d = (e as any).detail;
    if (d?.type === "error") errors.push(String(d.text ?? ""));
  });
  page.addEventListener("pageerror", (e) => {
    // deno-lint-ignore no-explicit-any
    errors.push(String((e as any).detail?.message ?? (e as any).detail ?? e));
  });
  return errors;
}

/**
 * How many distinct frames the compositor drew while the main thread was blocked for `ms`,
 * with the element `id` scrolled into view (an animation off screen draws nothing).
 */
async function framesWhileBlocked(page: Page, id: string, ms = 500): Promise<number> {
  await page.evaluate(`${el(id)}.scrollIntoView({ block: "center" })`);
  // deno-lint-ignore no-explicit-any
  const cdp = page.unsafelyGetCelestialBindings() as any;
  const frames: { t: number; data: string }[] = [];
  const onFrame = (e: CustomEvent) => {
    frames.push({ t: performance.now(), data: e.detail.data });
    cdp.Page.screencastFrameAck({ sessionId: e.detail.sessionId }).catch(() => {});
  };
  cdp.addEventListener("Page.screencastFrame", onFrame);
  await cdp.Page.startScreencast({ format: "jpeg", quality: 60, everyNthFrame: 1 });
  await new Promise((r) => setTimeout(r, 150));
  const from = performance.now();
  await page.evaluate(
    `(() => { const end = performance.now() + ${ms}; while (performance.now() < end) {} })()`,
  );
  const to = performance.now();
  await cdp.Page.stopScreencast();
  cdp.removeEventListener("Page.screencastFrame", onFrame);
  // The frames that arrived inside the block (a margin at each end for the round trips).
  return new Set(frames.filter((f) => f.t > from + 50 && f.t < to - 30).map((f) => f.data)).size;
}

/** The element's running animations: count, and the first one's kind and iterations. */
const anims = (id: string) =>
  `(() => { const a = ${el(id)}.getAnimations(); return { n: a.length, ` +
  `kind: a[0]?.constructor.name, iterations: String(a[0]?.effect.getComputedTiming().iterations) }; })()`;

/** The y translation of the test element `id`'s computed transform (0 when none). */
const translateY = (id: string) =>
  `(new DOMMatrixReadOnly(getComputedStyle(${
    el(id)
  }).transform === "none" ? undefined : getComputedStyle(${el(id)}).transform)).m42`;

/** The whole scenario against one running server. */
async function exercise(t: Deno.TestContext, server: RunningServer, label: string): Promise<void> {
  await t.step(`${label}: the bundle carries stamped worklets`, async () => {
    assertStringIncludes(await clientBundle(server.origin), "__workletHash");
  });

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = collectErrors(page);
    await page.goto(server.origin + "/");

    await t.step(`${label}: renders with no dev throw`, async () => {
      await pollFor(page, `${el("animate")} && ${el("pan")}`, 60_000);
      assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
      // The initial run of every worklet happened: fade starts at 0.2, width at 10px.
      await pollFor(page, `${style("fade", "opacity")} === "0.2"`);
      await pollFor(page, `${style("width", "width")} === "10px"`);
    });

    await t.step(`${label}: withTiming / withSpring drive animated styles`, async () => {
      await page.evaluate(`${el("animate")}.click()`);
      await pollFor(page, `${style("fade", "opacity")} === "1"`, 10_000);
      // useDerivedValue(progress * 2 * factor) → width 10 + 2 * 50.
      await pollFor(page, `${style("width", "width")} === "110px"`, 10_000);
      await pollFor(page, `Math.abs(${translateX("spring")} - 100) < 1`, 10_000);
      // useAnimatedReaction + runOnJS set React state.
      await pollFor(page, `${el("settled")}.textContent === "settled"`, 10_000);
    });

    await t.step(`${label}: a worklet re-runs when captured React state changes`, async () => {
      await page.evaluate(`${el("factor")}.click()`);
      await pollFor(page, `${el("factor-label")}.textContent === "factor 2"`, 10_000);
      await pollFor(page, `${style("factor-box", "height")} === "20px"`, 10_000);
      await pollFor(page, `${style("width", "width")} === "210px"`, 10_000);
    });

    await t.step(`${label}: useAnimatedScrollHandler follows the scroll`, async () => {
      await page.evaluate(`${el("scroller")}.scrollTop = 150`);
      await pollFor(page, `${style("scroll-box", "height")} === "150px"`, 10_000);
    });

    await t.step(`${label}: a Gesture.Pan() worklet moves the view`, async () => {
      const box = await page.evaluate(
        `(() => { const r = ${el("pan")}.getBoundingClientRect(); ` +
          `return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      ) as { x: number; y: number };
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.move(box.x + 60, box.y, { steps: 6 });
      await page.mouse.move(box.x + 120, box.y, { steps: 6 });
      await pollFor(page, `${translateX("pan")} > 60`, 10_000);
      await page.mouse.up();
    });

    await t.step(`${label}: nothing on screen changes while an idle page is blocked`, async () => {
      await pollFor(page, `${el("move-box")} && ${el("move-box")}.getAnimations().length === 0`);
      await new Promise((r) => setTimeout(r, 1700)); // the mount-time dim animation settles
      const idle = await framesWhileBlocked(page, "move-box");
      assert(idle <= 2, `an idle page drew ${idle} frames while blocked`);
    });

    await t.step(
      `${label}: sv = withTiming → a compositor animation that runs through a 500 ms block`,
      async () => {
        await page.evaluate(`${el("move")}.click()`);
        const a = await page.evaluate(anims("move-box")) as { n: number; kind: string };
        assertEquals([a.n, a.kind], [1, "Animation"]);
        const frames = await framesWhileBlocked(page, "move-box");
        assert(frames >= 5, `only ${frames} frames while the main thread was blocked`);
        // The completion callback (runOnJS) fires; the final value lands inline.
        await pollFor(page, `${el("moved")}.textContent === "moved"`, 10_000);
        await pollFor(page, `Math.abs(${translateX("move-box")} - 200) < 0.5`);
        await pollFor(page, `${style("move-box", "opacity")} === "0.5"`);
        assertEquals((await page.evaluate(anims("move-box")) as { n: number }).n, 0);
      },
    );

    await t.step(
      `${label}: the same animation on Reanimated's own loop stops while blocked`,
      async () => {
        // The pass's opt-out: Reanimated's requestAnimationFrame loop, as without the pass.
        await page.evaluate("globalThis.__DENEXT_REANIMATED_WAAPI = false");
        await page.evaluate(`${el("move-back")}.click()`);
        assertEquals((await page.evaluate(anims("move-box")) as { n: number }).n, 0);
        const frames = await framesWhileBlocked(page, "move-box");
        assert(frames <= 2, `the main-thread loop drew ${frames} frames while blocked`);
        await pollFor(page, `Math.abs(${translateX("move-box")}) < 0.5`, 10_000);
        await page.evaluate("delete globalThis.__DENEXT_REANIMATED_WAAPI");
      },
    );

    await t.step(
      `${label}: an animation returned from the style runs on the compositor`,
      async () => {
        await page.evaluate(`${el("dim")}.click()`);
        await pollFor(page, `${el("dim-box")}.getAnimations().length === 1`);
        await pollFor(page, `${style("dim-box", "opacity")} === "0.3"`, 10_000);
        await pollFor(page, `${el("dim-box")}.getAnimations().length === 0`, 10_000);
      },
    );

    await t.step(`${label}: withSequence out and back, and a forever withRepeat`, async () => {
      await page.evaluate(`${el("seq")}.click()`);
      await pollFor(page, `${el("seq-box")}.getAnimations().length === 1`);
      await pollFor(page, `${translateY("seq-box")} > 10`, 10_000);
      await pollFor(page, `${el("seq-box")}.getAnimations().length === 0`, 10_000);
      assertEquals(await page.evaluate(translateY("seq-box")), 0);
      await page.evaluate(`${el("spin-toggle")}.click()`);
      await pollFor(page, `${el("spin-box")} && ${el("spin-box")}.getAnimations().length === 1`);
      const spin = await page.evaluate(anims("spin-box")) as { iterations: string };
      assertEquals(spin.iterations, "Infinity"); // (a number would not survive the JSON trip)
      await page.evaluate(`${el("spin-toggle")}.click()`);
      await pollFor(page, `!${el("spin-box")}`);
    });

    await t.step(
      `${label}: a FadeIn entering animation is CSS, and runs through a block`,
      async () => {
        await page.evaluate(`${el("enter-toggle")}.click()`);
        await pollFor(page, `${el("enter-box")} && ${el("enter-box")}.getAnimations().length > 0`);
        const a = await page.evaluate(anims("enter-box")) as { kind: string };
        assertEquals(a.kind, "CSSAnimation");
        const frames = await framesWhileBlocked(page, "enter-box");
        assert(frames >= 5, `only ${frames} frames while the main thread was blocked`);
      },
    );

    await t.step(`${label}: LayoutAnimation.configureNext animates the moved views`, async () => {
      // The preset's move runs for 300 ms and pollFor samples every 100 ms plus a CDP round
      // trip, so polling getAnimations() for it can miss the whole animation on a loaded runner.
      // Record every animation started on the moved row instead, then wait for it to finish.
      await page.evaluate(`(() => {
        const started = globalThis.__laStarted = [];
        const animate = Element.prototype.animate;
        globalThis.__laRestore = () => { Element.prototype.animate = animate; };
        Element.prototype.animate = function (...args) {
          const a = animate.apply(this, args);
          if (this.getAttribute("data-testid") === "la-b") started.push(a);
          return a;
        };
      })()`);
      try {
        await page.evaluate(`${el("la-add")}.click()`);
        await pollFor(page, `${el("la-a")} && globalThis.__laStarted.length > 0`, 10_000);
        // FLIP: "a" is inserted above, so "b" moves down one 30 px row and starts drawn back
        // at its old place (none at all: react-native-web's no-op configureNext).
        const first = await page.evaluate(
          "String(globalThis.__laStarted[0].effect.getKeyframes()[0].transform)",
        ) as string;
        assertStringIncludes(first, "translate(0px, -30px)");
        await pollFor(page, `${el("la-b")}.getAnimations().length === 0`, 10_000);
      } finally {
        await page.evaluate("globalThis.__laRestore?.()");
      }
    });

    await t.step(`${label}: no console errors`, () => {
      assert(errors.length === 0, `console errors:\n${errors.join("\n")}`);
    });
  } finally {
    await browser.close();
  }
}

Deno.test({
  name: "e2e: Reanimated 4 + gesture-handler run in React Native mode without the Babel plugin",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await setup();
  if (!dir) return;
  try {
    const dev = await startSpaDevOnDir(dir);
    try {
      await exercise(t, dev, "dev");
    } finally {
      await dev.close();
    }
    const prod = await buildAndServe(dir);
    try {
      await exercise(t, prod, "prod");
    } finally {
      await prod.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
