// Migration beds: the two apps Fresh's own scaffold (`@fresh/init` 2.3.3, the one the Fresh docs
// start every project with) generates — the default Vite app with Tailwind (`vite.config.ts`,
// `client.ts`, `assets/styles.css`) and the `--builder` app on Fresh's own builder (`dev.ts`,
// `static/styles.css`). Each has `main.ts` middleware and an `app.get()` route, an `_app`, a page
// passing a signal to a Counter island, and a `[name]` API route. `denext migrate` must carry
// everything (nothing won't-migrate); the app is built, served, every route fetched, and the
// island hydrated and clicked in headless Chromium.
//
// Pin: the Fresh repository at 39b5f06 (the `2.3.3` tag, the fresh-www bed's pin) is cloned for
// the harness; `prepare` replaces the app directory with what `jsr:@fresh/init@2.3.3` writes.
// NETWORK-REQUIRED (GitHub fetch + JSR / npm downloads): `deno task test:migration-bed`.

import { join } from "@std/path";
import { type Bed, runBed } from "./_bed.ts";

/** Replace the app directory with a fresh `@fresh/init` scaffold (`flags`: `--builder`, …). */
function scaffold(flags: string[]): (app: string) => Promise<void> {
  return async (app) => {
    for await (const e of Deno.readDir(app)) {
      await Deno.remove(join(app, e.name), { recursive: true });
    }
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "jsr:@fresh/init@2.3.3", ".", "--force", "--vscode", ...flags],
      cwd: app,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(180_000),
    }).output();
    if (!out.success) {
      throw new Error(`@fresh/init failed:\n${new TextDecoder().decode(out.stderr)}`);
    }
  };
}

/** The routes both scaffolds answer. */
const ROUTES: Bed["routes"] = [
  { path: "/", contains: "Welcome to Fresh" },
  { path: "/", contains: "<title>Fresh counter</title>" },
  // The signal the page passes the island renders its value on the server.
  { path: "/", contains: ">3</p>" },
  { path: "/api/joe", contains: "Hello, Joe!" },
  // main.ts's code route.
  { path: "/api2/ann", contains: "Hello, Ann!" },
  { path: "/logo.svg", contains: "<svg" },
];

/** The Counter island, hydrated: its +1 button moves the signal the page passed it. */
const BROWSER: Bed["browser"] = {
  path: "/",
  hydrated: 'document.querySelector("#increment") !== null && ' +
    "[...document.scripts].some((s) => s.src.includes('/_denext/client/'))",
  interact: {
    click: "#increment",
    until: '[...document.querySelectorAll(".tabular-nums")].some((e) => e.textContent === "4")',
  },
};

const BASE = {
  repo: "https://github.com/freshframework/fresh.git",
  sha: "39b5f06f8a7d7fa02dd2e2950f2291d04ef9fea7",
  subdir: "packages/init",
  install: [],
  kind: "fresh",
  wontMigrate: [],
  routes: ROUTES,
  browser: BROWSER,
};

const VITE: Bed = {
  ...BASE,
  name: "fresh-init-vite",
  prepare: scaffold(["--tailwind"]),
  files: [
    { path: "app/layout.tsx", contains: ["styles.gen.css"] },
    { path: "middleware.ts", contains: ['import * as main from "./main.ts";'] },
  ],
};

const BUILDER: Bed = {
  ...BASE,
  name: "fresh-init-builder",
  prepare: scaffold(["--builder", "--no-tailwind"]),
  files: [{ path: "public/styles.css", contains: [".fresh-gradient"] }],
};

Deno.test({ name: "migration bed: @fresh/init's Vite + Tailwind app" }, (t) => runBed(t, VITE));
Deno.test({ name: "migration bed: @fresh/init's builder app" }, (t) => runBed(t, BUILDER));
