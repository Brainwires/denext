// Real-browser end-to-end test: a Fast Refresh of a component that renders a `VirtualList`
// keeps the list's scroll position, its measured row sizes and its rows' state — the same
// guarantee React's Fast Refresh gives any other component — with NO `restoreKey`.
//
// Two edits, on the SPA and App Router dev loops — unbundled per-module HMR (the default) and
// the bundled whole-entry refresh (`unbundled: false`):
//
// 1. A body-only edit (the hooks are unchanged): the edited component reconciles onto the live
//    fiber tree, so the list is not remounted — the anchor row, its pixel offset and every
//    rendered row's `useState` survive, and the page does not reload.
// 2. A hook-signature edit (a `useState` added): reusing the hook cells is unsafe, so the
//    refresh runtime falls back to a full page reload — and the list, remounted by that
//    reload, lands back on the same anchor row in dev on its own.
//
// Opt-in: run with `deno task test:e2e`. Excluded from `deno task test`/`check`.

import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import type { Page } from "@astral/astral";
import {
  launchBrowser,
  pollFor,
  type RunningServer,
  startDevOnDir,
  startSpaDevOnDir,
} from "./harness.ts";

const SPA_FIXTURE = fromFileUrl(new URL("./fixtures/spa", import.meta.url));
const FRAMEWORK_ROOT = fromFileUrl(new URL("../../", import.meta.url));

/** The list component: 1000 rows of varied heights, each carrying a mount-time nonce (state). */
function listSource(name: string, exportLine: string): string {
  return `${exportLine}import { useState, VirtualList } from "denext";

const DATA = Array.from({ length: 1000 }, (_, i) => i);

function Cell({ n }: { n: number }) {
  const [nonce] = useState(() => Math.random().toString(36).slice(2));
  return (
    <div class="row" data-row={n} data-nonce={nonce} style={{ height: \`\${30 + (n % 5) * 10}px\` }}>
      Row {n} LABEL
    </div>
  );
}

export function ${name}() {
  const [data] = useState(DATA);
  return (
    <div style={{ height: "400px", display: "flex", flexDirection: "column" }}>
      <h1 data-testid="title">List v1</h1>
      <VirtualList
        data={data}
        keyExtractor={(n: number) => n}
        estimatedItemSize={50}
        style={{ flex: "1", minHeight: "0" }}
        ref={(h: unknown) => { (globalThis as Record<string, unknown>).__vl = h; }}
        renderItem={(n: number) => <Cell n={n} />}
      />
    </div>
  );
}
`;
}

const LAYOUT = `export default function RootLayout({ children }: { children: unknown }) {
  return (
    <html lang="en">
      <body>{children as never}</body>
    </html>
  );
}
`;

const PAGE = `import { List } from "./list.tsx";

export default function Page() {
  return <List />;
}
`;

/** A deno.json mapping `denext*` to absolute framework URLs. */
async function writeImports(dir: string): Promise<void> {
  const abs = (rel: string) => toFileUrl(join(FRAMEWORK_ROOT, rel)).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "denext",
        lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
      },
      imports: {
        "denext": abs("mod.ts"),
        "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
        "denext/server": abs("src/server/mod.ts"),
        "denext/client": abs("src/client/mod.ts"),
      },
    }),
  );
}

/** A SPA (`createRoot`) whose `src/app.tsx` renders the list; returns the file to edit. */
async function spaApp(dir: string): Promise<string> {
  await copy(SPA_FIXTURE, dir, { overwrite: true });
  await Deno.writeTextFile(join(dir, "src/app.tsx"), listSource("App", ""));
  return join(dir, "src/app.tsx");
}

/** An App Router app whose server page renders the `"use client"` list; the file to edit. */
async function appRouterApp(dir: string): Promise<string> {
  await Deno.mkdir(join(dir, "app"), { recursive: true });
  await Deno.writeTextFile(join(dir, "app/layout.tsx"), LAYOUT);
  await Deno.writeTextFile(join(dir, "app/page.tsx"), PAGE);
  await Deno.writeTextFile(join(dir, "app/list.tsx"), listSource("List", '"use client";\n'));
  return join(dir, "app/list.tsx");
}

/** The view: the first row intersecting the scroller, its px gap and the rows' nonces. */
interface View {
  readonly anchor: number;
  readonly gap: number;
  readonly scrollTop: number;
  readonly nonces: Record<string, string>;
}

const READ_VIEW = `(() => {
  const sc = document.querySelector("[data-denext-virtual-list]");
  const top = sc.getBoundingClientRect().top;
  const rows = [...sc.querySelectorAll("[data-row]")]
    .sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row));
  const first = rows.find((r) => r.getBoundingClientRect().bottom > top + 0.5);
  const nonces = {};
  for (const r of rows) nonces[r.dataset.row] = r.dataset.nonce;
  return {
    anchor: Number(first.dataset.row),
    gap: Math.round(first.getBoundingClientRect().top - top),
    scrollTop: Math.round(sc.scrollTop),
    nonces,
  };
})()`;

async function readView(page: Page): Promise<View> {
  return await page.evaluate(READ_VIEW) as View;
}

/** Wait until two reads 150 ms apart agree (the list has settled after a commit). */
async function settledView(page: Page): Promise<View> {
  let prev = await readView(page);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const next = await readView(page);
    if (next.anchor === prev.anchor && next.gap === prev.gap) return next;
    prev = next;
  }
  return prev;
}

/** One dev-loop flavour to exercise. */
interface Scenario {
  readonly name: string;
  readonly setup: (dir: string) => Promise<string>;
  readonly start: (dir: string) => Promise<RunningServer>;
  /**
   * Run in a child `deno test` process. The dev server keeps some module-level state per
   * process (one app per process in real use), so a second App Router app started in the same
   * process renders its client component as a server one (a null Flight payload, nothing
   * hydrates) — the harness, not the refresh, is what that would test.
   */
  readonly isolate?: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "App Router, unbundled per-module HMR",
    setup: appRouterApp,
    start: (dir) => startDevOnDir(dir, {}, { unbundled: true }),
  },
  {
    name: "App Router, bundled whole-entry refresh",
    setup: appRouterApp,
    start: (dir) => startDevOnDir(dir, {}, { unbundled: false }),
    isolate: true,
  },
  {
    name: "SPA, bundled whole-entry refresh",
    setup: spaApp,
    start: (dir) => startSpaDevOnDir(dir, {}, { unbundled: false }),
  },
  {
    name: "SPA, unbundled per-module HMR",
    setup: spaApp,
    start: (dir) => startSpaDevOnDir(dir, {}, { unbundled: true }),
  },
];

/** `pollFor`, tolerating the evaluation contexts a page reload destroys mid-poll. */
async function pollAcrossReload(page: Page, expr: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await page.evaluate(`!!(${expr})`)) return;
    } catch { /* the page is reloading */ }
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms: ${expr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Edit `file` and wait for the title to read `title` (after a reload, when `reload`). */
async function edit(
  page: Page,
  file: string,
  change: (src: string) => string,
  title: string,
  reload: boolean,
): Promise<void> {
  await Deno.writeTextFile(file, change(await Deno.readTextFile(file)));
  await pollAcrossReload(
    page,
    `${reload ? "window.__noReload !== true && " : ""}` +
      `!!document.querySelector('[data-testid="title"]') && ` +
      `document.querySelector('[data-testid="title"]').textContent.includes(${
        JSON.stringify(title)
      }) && !!document.querySelector("[data-row]") && !!globalThis.__vl`,
    60000,
  );
}

/** The scenario this process runs alone (a child started for an `isolate` one), if any. */
const ONLY = Deno.env.get("DENEXT_VL_HMR_ONLY");

/** Run `sc` in a child `deno test` of this file and fail with its output when it fails. */
async function runIsolated(sc: Scenario): Promise<void> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--unstable-kv", fromFileUrl(import.meta.url)],
    env: { DENEXT_VL_HMR_ONLY: sc.name },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assert(out.success, `isolated scenario failed:\n${text}`);
}

for (const sc of SCENARIOS) {
  if (ONLY !== undefined && sc.name !== ONLY) continue;
  const name = `e2e: Fast Refresh keeps a VirtualList's scroll and row state — ${sc.name}`;
  if (sc.isolate && ONLY === undefined) {
    Deno.test({ name, sanitizeOps: false, sanitizeResources: false }, () => runIsolated(sc));
    continue;
  }
  Deno.test({
    name,
    sanitizeOps: false,
    sanitizeResources: false,
  }, async (t) => {
    const dir = await Deno.makeTempDir({ prefix: "denext_vl_hmr_" });
    const file = await sc.setup(dir);
    await writeImports(dir);
    await Deno.remove(join(dir, ".denext"), { recursive: true }).catch(() => {});
    const server = await sc.start(dir);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage(server.origin + "/");
      await pollFor(page, "!!globalThis.__vl && !!document.querySelector('[data-row]')", 180000);

      let before: View | undefined;
      await t.step("scroll to row 500", async () => {
        await page.evaluate("globalThis.__vl.scrollToIndex(500)");
        await page.waitForFunction("!!document.querySelector('[data-row=\"500\"]')");
        // Nudge off the row boundary so the gap is a real, non-zero offset.
        await page.evaluate(
          "document.querySelector('[data-denext-virtual-list]').scrollTop += 17",
        );
        before = await settledView(page);
        assert(before.anchor >= 499 && before.anchor <= 501, `anchor ${before.anchor}`);
        await page.evaluate("window.__noReload = true");
      });

      await t.step("a body edit keeps the anchor, the gap and every row's state", async () => {
        await edit(page, file, (s) => s.replace("List v1", "List v2"), "List v2", false);
        const after = await settledView(page);
        assert(await page.evaluate("window.__noReload === true"), "no full reload");
        assertEquals(after.anchor, before!.anchor, "anchor row kept");
        assert(Math.abs(after.gap - before!.gap) <= 1, `gap ${before!.gap} → ${after.gap}`);
        const prior = before!;
        before = after;
        for (const [row, nonce] of Object.entries(prior.nonces)) {
          if (after.nonces[row] !== undefined) {
            assertEquals(after.nonces[row], nonce, `row ${row} was remounted`);
          }
        }
      });

      await t.step(
        "a hook-signature edit reloads, and the list lands on the same row",
        async () => {
          await edit(
            page,
            file,
            (s) =>
              s.replace("List v2", "List v3")
                .replace(
                  "const [data] = useState(DATA);",
                  "const [data] = useState(DATA);\n  const [extra] = useState(1);",
                )
                .replace('<h1 data-testid="title">', '<h1 data-testid="title" data-extra={extra}>'),
            "List v3",
            true,
          );
          const after = await settledView(page);
          assertEquals(after.anchor, before!.anchor, "anchor row restored across the reload");
          assert(Math.abs(after.gap - before!.gap) <= 1, `gap ${before!.gap} → ${after.gap}`);
        },
      );
    } finally {
      await browser.close();
      await server.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
}
