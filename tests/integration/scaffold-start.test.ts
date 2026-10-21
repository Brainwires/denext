// `denext create`'s least-privilege `start` task serves a built app with exactly its flags.
//
// Every template writes `start` as `deno run --allow-net --allow-read --allow-env
// --allow-write=.denext <cli> start .` — no `--allow-run`. Up to 3.4.16 that task died with
// `NotCapable: Requires run access` on every scaffolded app: the CLI rebuilt the stylesheets and
// re-ran itself under a CSS import map (a second `deno`), and an app with no Flight route
// re-crawled its import graph with a `deno info` child. Now the build's server copies point each
// stylesheet import at its shim and the manifest records the crawled boundary, so `start` spawns
// nothing. Each case scaffolds a template, builds it the way its `build` task does, then runs the
// `start` task's own flags (read from the generated deno.json, so a change to them is tested too)
// against this checkout's CLI and fetches the home page.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { type ScaffoldOptions, scaffoldProject } from "../../src/build/scaffold.ts";
import { removeTempDir } from "../helpers/temp.ts";
import { cachedToolchain, linkedEnv } from "../helpers/toolchain.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const FW_URL = toFileUrl(FW).href;

/** The scaffolded deno.json's tasks and imports (the parts this test reads and rewrites). */
interface DenoJson {
  tasks: Record<string, string>;
  imports: Record<string, string>;
  lint?: unknown;
}

/** Point the app's `denext` imports at this checkout (the JSR release may not exist yet). */
async function pointAtThisCheckout(dir: string): Promise<DenoJson> {
  const path = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(path)) as DenoJson;
  for (const key of Object.keys(cfg.imports)) if (key.startsWith("denext")) delete cfg.imports[key];
  Object.assign(cfg.imports, {
    "denext": `${FW_URL}mod.ts`,
    "denext/": `${FW_URL}src/`,
    "denext/jsx-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
    "denext/jsx-dev-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
    "denext/server": `${FW_URL}src/server/mod.ts`,
    "denext/client": `${FW_URL}src/client/mod.ts`,
    "denext/testing": `${FW_URL}src/testing/mod.ts`,
  });
  delete cfg.lint; // the lint plugin is a JSR specifier too, and nothing here lints
  await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2));
  return cfg;
}

/**
 * A `deno run <flags> jsr:@denext/denext@…/cli <args>` task as `deno` arguments that run this
 * checkout's CLI with the same permission flags and verb arguments.
 */
function taskArgs(task: string, dir: string): { flags: string[]; args: string[] } {
  const words = task.trim().split(/\s+/);
  assertEquals(words.slice(0, 2), ["deno", "run"], task);
  const cli = words.findIndex((w) => /^jsr:@denext\/denext@[^/]+\/cli$/.test(w));
  assert(cli > 1, `no denext CLI in the task: ${task}`);
  return {
    flags: words.slice(2, cli),
    args: ["--config", join(dir, "deno.json"), join(FW, "cli.ts"), ...words.slice(cli + 1)],
  };
}

/** A free loopback port. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

/** The `deno` a task runs on, and its environment. */
interface Runner {
  readonly deno: string;
  readonly env: Record<string, string>;
}

/** The Deno running this suite. */
const STOCK: Runner = { deno: Deno.execPath(), env: { NO_COLOR: "1" } };

/** Run the app's `build` task's flags to completion; fail with its output. */
async function build(dir: string, cfg: DenoJson, run: Runner = STOCK): Promise<void> {
  const { flags, args } = taskArgs(cfg.tasks.build, dir);
  const out = await new Deno.Command(run.deno, {
    args: ["run", ...flags, ...args],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    env: run.env,
  }).output();
  const dec = new TextDecoder();
  assertEquals(out.code, 0, `build failed:\n${dec.decode(out.stdout)}${dec.decode(out.stderr)}`);
}

/** Run the `start` task's exact flags, fetch `/`, and stop the server; the page and output. */
async function start(
  dir: string,
  cfg: DenoJson,
  run: Runner = STOCK,
  path = "/",
): Promise<{ html: string; output: string }> {
  const { flags, args } = taskArgs(cfg.tasks.start, dir);
  assert(!flags.some((f) => f === "-A" || f.startsWith("--allow-run")), cfg.tasks.start);
  const port = freePort();
  const child = new Deno.Command(run.deno, {
    args: ["run", ...flags, ...args, "--port", String(port)],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
    env: run.env,
  }).spawn();
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  let exited = false;
  child.status.then(() => exited = true);
  let html = "";
  try {
    // Generous: a loaded machine takes a while to load the app's modules.
    for (let i = 0; i < 1200 && !exited && !html; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        const text = await res.text();
        if (res.status === 200) html = text;
      } catch { /* not listening yet */ }
      if (!html) await new Promise((r) => setTimeout(r, 100));
    }
    // A second request once the first was delivered: Deno's legacy-abort notice prints on the
    // first response whose signal was read, so it is in the output by now if it is coming.
    if (html) await (await fetch(`http://127.0.0.1:${port}/`)).body?.cancel();
  } finally {
    if (!exited) child.kill("SIGTERM");
    await child.status;
    await drained;
  }
  return { html, output };
}

const CASES: { name: string; opts: Omit<ScaffoldOptions, "dir">; expect: string[] }[] = [
  {
    name: "the default template",
    opts: {},
    expect: ["Hello from denext", "Clicked 0 times", `href="/styles.css"`],
  },
  { name: "the minimal template", opts: { template: "minimal" }, expect: ["Hello from denext"] },
  {
    // The layout imports the compiled stylesheet: its server copy imports the shim instead.
    name: "the default template with Tailwind",
    opts: { tailwind: true },
    expect: ["Hello from denext", "Clicked 0 times", "/_denext/client/index.css"],
  },
];

const TOOLCHAIN = cachedToolchain();

/**
 * Where the least-privilege `start` runs: on denext's toolchain (a `denext task start`, the
 * generated image and unit), else — no toolchain cached — this suite's Deno with the explicit
 * `DENEXT_DENO=stock` opt-out (without it, the task refuses: see the test below).
 */
const SERVE: Runner = TOOLCHAIN
  ? { deno: TOOLCHAIN, env: linkedEnv(TOOLCHAIN) }
  : { deno: STOCK.deno, env: { ...STOCK.env, DENEXT_DENO: "stock" } };

for (const { name, opts, expect } of CASES) {
  Deno.test(`denext create: ${name}'s least-privilege start task serves the built app`, async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_scaffold_start_" }));
    try {
      await scaffoldProject({ dir, vscode: false, ...opts });
      const cfg = await pointAtThisCheckout(dir);
      await build(dir, cfg);
      const { html, output } = await start(dir, cfg, SERVE);
      assert(!output.includes("NotCapable"), output);
      assert(html, `start served nothing:\n${output}`);
      for (const text of expect) assertStringIncludes(html, text);
    } finally {
      await removeTempDir(dir);
    }
  });
}

/** An API route reporting the runtime that serves it. */
async function addRuntimeRoute(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "app/api/runtime"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "app/api/runtime/route.ts"),
    "export function GET(): Response {\n" +
      "  // deno-lint-ignore no-explicit-any\n" +
      "  const sql = typeof (Deno as any).SQL;\n" +
      "  return Response.json({ sql, deno: Deno.version.deno });\n}\n",
  );
}

Deno.test({
  name: "denext create: the start task never serves on stock Deno without the opt-out",
  // Up to 4.5.0 the least-privilege task (no --allow-run) served in-process on whatever Deno ran
  // it, so `Deno.SQL` (postgresClient(), the Prisma adapter) worked in `dev` and was missing in
  // production. Now it refuses with the ways out — unless this suite already runs on the toolchain.
  ignore: Deno.version.deno.includes("denext"),
  fn: async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_scaffold_start_" }));
    try {
      await scaffoldProject({ dir, vscode: false, template: "minimal" });
      const cfg = await pointAtThisCheckout(dir);
      await build(dir, cfg);
      const env = { ...STOCK.env, DENEXT_DENO: "", DENEXT_TOOLCHAIN_ACTIVE: "" };
      const { html, output } = await start(dir, cfg, { deno: STOCK.deno, env });
      assertEquals(html, "", `served on stock Deno:\n${output}`);
      assertStringIncludes(output, "can't start denext's Deno toolchain");
      assertStringIncludes(output, "denext task start");
    } finally {
      await removeTempDir(dir);
    }
  },
});

Deno.test({
  name: "denext create: the start task on the toolchain serves with Deno.SQL",
  ignore: TOOLCHAIN === null,
  fn: async () => {
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_scaffold_start_" }));
    try {
      await scaffoldProject({ dir, vscode: false, template: "minimal" });
      await addRuntimeRoute(dir);
      const cfg = await pointAtThisCheckout(dir);
      await build(dir, cfg);
      const { html, output } = await start(dir, cfg, SERVE, "/api/runtime");
      const body = JSON.parse(html) as { sql: string; deno: string };
      assertEquals(body.sql, "function", output);
      assertStringIncludes(body.deno, "denext");
    } finally {
      await removeTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "denext create: the start task on denext's toolchain serves without the legacy-abort notice",
  // The pinned toolchain, already in the cache: started on it directly (a `toolchain link`ed
  // `deno`), the least-privilege task cannot re-run itself with `--unstable-no-legacy-abort`, so
  // the scaffolded deno.json's `"unstable": ["no-legacy-abort"]` is what turns it on.
  ignore: TOOLCHAIN === null,
  fn: async () => {
    const run: Runner = { deno: TOOLCHAIN!, env: linkedEnv(TOOLCHAIN!) };
    const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_scaffold_start_" }));
    try {
      await scaffoldProject({ dir, vscode: false, template: "minimal" });
      const cfg = await pointAtThisCheckout(dir);
      await build(dir, cfg, run);
      const { html, output } = await start(dir, cfg, run);
      assert(html, `start served nothing:\n${output}`);
      assertStringIncludes(html, "Hello from denext");
      assert(!output.includes("(legacy behavior)"), output);
    } finally {
      await removeTempDir(dir);
    }
  },
});
