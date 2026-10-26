// A migrated Next.js App Router app (the next-compat drop-in) serves its pages, stylesheets
// included, under the least-privilege `start` task `denext migrate` writes.
//
// Up to 4.6.0 that task was `-A`: a next-compat build recorded nothing about its stylesheets, so
// `start` rebuilt them and re-ran itself under the CSS import map, a second `deno` that needs an
// unscoped `--allow-run`, after writing the CSS redirects into the app's deno.json. The compat
// server bundle has always carried each stylesheet import as its shim; the build now records that
// (`compatCss` in manifest.json), so `start` skips the re-exec and spawns nothing. This migrates a
// Next app against this checkout, builds it with its `build` task, runs its `start` task's exact
// flags and fetches the home page: a global stylesheet and a CSS module (whose class names only
// the shim supplies on the server).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { migrateProject } from "../../packages/migrate/src/migrate.ts";
import { removeTempDir } from "../helpers/temp.ts";
import { cachedToolchain, linkedEnv } from "../helpers/toolchain.ts";
import {
  buildTask,
  type Runner,
  startTask,
  STOCK,
  type TaskConfig,
} from "../helpers/start-task.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));

/** A Next.js App Router app: React and `next/*` imports, a global stylesheet and a CSS module. */
const NEXT_APP: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "next-compat-start",
    private: true,
    dependencies: { next: "^15", react: "^19", "react-dom": "^19" },
  }),
  "app/globals.css": ".page { color: rgb(7, 8, 9); }\n",
  "app/card.module.css": ".card { border: 1px solid rgb(1, 2, 3); }\n",
  "app/layout.tsx": `import type { ReactNode } from "react";
import "./globals.css";
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/counter.tsx": `"use client";
import { useState } from "react";
import styles from "./card.module.css";
export function Counter() {
  const [n, setN] = useState(0);
  return <button type="button" className={styles.card} onClick={() => setN(n + 1)}>Clicked {n}</button>;
}
`,
  "app/page.tsx": `import Link from "next/link";
import styles from "./card.module.css";
import { Counter } from "./counter";
export default async function Home() {
  const greeting = await Promise.resolve("compat start rendered");
  return <main className={"page " + styles.card}><h1>{greeting}</h1><Counter /><Link href="/about">About</Link></main>;
}
`,
  "app/about/page.tsx": "export default function About() {\n  return <h1>about</h1>;\n}\n",
};

/** Write `files` under `dir`. */
async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
}

const TOOLCHAIN = cachedToolchain();

/**
 * Where `start` runs: on denext's toolchain when it is cached (what `denext task start`, the
 * image and the unit run), else this suite's Deno with the `DENEXT_DENO=stock` opt-out. Either
 * way `DENEXT_MODULE_ACTIVE` stands in for the published CLI: a `jsr:` CLI never takes the
 * module re-exec, while this checkout's `cli.ts` (a `file:` URL) would for the migrated config's
 * `npm:` entries, which is a source-checkout concern, not the app's.
 */
const SERVE: Runner = TOOLCHAIN
  ? { deno: TOOLCHAIN, env: { ...linkedEnv(TOOLCHAIN), DENEXT_MODULE_ACTIVE: "1" } }
  : { deno: STOCK.deno, env: { ...STOCK.env, DENEXT_DENO: "stock", DENEXT_MODULE_ACTIVE: "1" } };

Deno.test("denext migrate: a Next.js App Router app serves pages with CSS under its least-privilege start", async () => {
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_compat_start_" }));
  try {
    await writeFiles(dir, NEXT_APP);
    await migrateProject(dir, { from: "next", denextLocalPath: FW });
    const configText = await Deno.readTextFile(join(dir, "deno.json"));
    const cfg = JSON.parse(configText) as TaskConfig;
    assertStringIncludes(cfg.tasks.start, "--allow-write=.denext");
    await buildTask(dir, cfg);
    const manifest = JSON.parse(await Deno.readTextFile(join(dir, ".denext", "manifest.json")));
    assertEquals([manifest.nextCompat, manifest.compatCss], [true, true]);

    // startTask refuses a task with -A or --allow-run before running it.
    const { html, output } = await startTask(dir, cfg, SERVE);
    assert(!output.includes("NotCapable"), output);
    assert(html, `start served nothing:\n${output}`);
    assertStringIncludes(html, "compat start rendered");
    assertStringIncludes(html, "Clicked 0");
    // The CSS module's class name came from its shim, inside the server bundle.
    const card = /class="page ([A-Za-z0-9_-]+card)"/.exec(html);
    assert(card, `no CSS module class on the page:\n${html}`);
    assertStringIncludes(html, "/_denext/client/index.css");
    // No re-exec: the app's deno.json was never rewritten with CSS redirects.
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), configText);
  } finally {
    await removeTempDir(dir);
  }
});
