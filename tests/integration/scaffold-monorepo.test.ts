// `denext create --monorepo`, end to end: the scaffolded workspace's root `check` task (fmt, lint
// and every member's tests) passes, `apps/web` builds and serves a page that renders the shared
// packages on the server and ships them in the client bundle (the package's stylesheet export
// included), and `denext dev` in `apps/web` serves the packages per module and hot-updates an edit
// made across the package boundary.
//
// The scaffold pins the JSR release of this version, which may not be published yet: the
// configs are pointed at this checkout first (the app's and the UI package's `denext` imports,
// the root's lint plugin and its `test` task's CLI).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { scaffoldMonorepo } from "../../src/build/scaffold-monorepo.ts";
import { removeTempDir } from "../helpers/temp.ts";
import { cachedToolchain, linkedEnv } from "../helpers/toolchain.ts";

const FW = fromFileUrl(new URL("../../", import.meta.url));
const FW_URL = toFileUrl(FW).href;
const CLI = join(FW, "cli.ts");

/** The checkout's denext entries, for a member's import map. */
const CHECKOUT_IMPORTS: Record<string, string> = {
  "denext": `${FW_URL}mod.ts`,
  "denext/jsx-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
  "denext/jsx-dev-runtime": `${FW_URL}src/jsx/jsx-runtime.ts`,
  "denext/server": `${FW_URL}src/server/mod.ts`,
  "denext/client": `${FW_URL}src/client/mod.ts`,
  "denext/testing": `${FW_URL}src/testing/mod.ts`,
};

/** A parsed config. */
type Json = Record<string, Record<string, unknown>>;

/** Rewrite a JSON config in place. */
async function editJson(path: string, edit: (config: Json) => void): Promise<void> {
  const config = JSON.parse(await Deno.readTextFile(path)) as Json;
  edit(config);
  await Deno.writeTextFile(path, JSON.stringify(config, null, 2) + "\n");
}

/** Point the workspace at this checkout (see the header). */
async function pointAtThisCheckout(root: string): Promise<void> {
  for (const member of ["apps/web", "packages/ui"]) {
    await editJson(join(root, member, "deno.json"), (config) => {
      for (const key of Object.keys(config.imports)) {
        if (key.startsWith("denext")) delete config.imports[key];
      }
      const extra = member === "apps/web" ? { "denext/": `${FW_URL}src/` } : {};
      Object.assign(config.imports, CHECKOUT_IMPORTS, extra);
    });
  }
  await editJson(join(root, "deno.json"), (config) => {
    config.lint.plugins = [`${FW_URL}src/lint/denext-plugin.ts`];
    config.tasks.test = `deno run -A --config ${join(FW, "deno.json")} ${CLI} test`;
  });
}

/** The `deno` the children run on (denext's toolchain when cached), and its environment. */
const TOOLCHAIN = cachedToolchain();
const RUN = TOOLCHAIN
  ? { deno: TOOLCHAIN, env: linkedEnv(TOOLCHAIN) }
  : { deno: Deno.execPath(), env: { NO_COLOR: "1", DENEXT_DENO: "stock" } };

/** Run `deno <args>` in `cwd` to completion; fail with its output. */
async function deno(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command(RUN.deno, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: RUN.env,
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `deno ${args.join(" ")} failed:\n${text}`);
  return text;
}

/** A free loopback port. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = l.addr as Deno.NetAddr;
  l.close();
  return port;
}

/** A running `denext <verb>` in `cwd`, its origin, and how to stop it. */
interface Server {
  readonly origin: string;
  get(path: string): Promise<Response>;
  stop(): Promise<string>;
}

/**
 * Start `denext <verb> . --port <p>` from this checkout in `cwd` with `flags`, and wait until `/`
 * answers 200.
 */
async function serve(verb: "start" | "dev", flags: string[], cwd: string): Promise<Server> {
  const port = freePort();
  const child = new Deno.Command(RUN.deno, {
    args: [
      "run",
      ...flags,
      "--config",
      join(cwd, "deno.json"),
      CLI,
      verb,
      ".",
      "--port",
      `${port}`,
      "--host",
      "127.0.0.1",
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: RUN.env,
  }).spawn();
  let output = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  let exited = false;
  child.status.then(() => exited = true);
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (!exited) child.kill("SIGTERM");
    await child.status;
    await drained;
    return output;
  };
  // Generous: a loaded machine takes a while to load the app's modules.
  for (let i = 0; i < 1800 && !exited; i++) {
    try {
      const res = await fetch(`${origin}/`);
      await res.body?.cancel();
      if (res.status === 200) return { origin, get: (p) => fetch(`${origin}${p}`), stop };
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`denext ${verb} never served /:\n${await stop()}`);
}

/** The page's text, asserting it rendered the shared packages on the server. */
async function sharedPage(server: Server): Promise<string> {
  const html = await (await server.get("/")).text();
  assertStringIncludes(html, '<div class="ui-card">'); // @acme/ui's Card, in a Server Component
  assertStringIncludes(html, '<button class="ui-button" type="button">'); // its Button, in the island
  assertStringIncludes(html, "Clicked 0 times"); // @acme/shared's pluralize
  return html;
}

/** The `@fs` dev URL a module's source names for `file` (a path suffix), asserted. */
function devUrl(source: string, file: RegExp): string {
  const url = new RegExp(`"(/_denext/@fs[^"]*${file.source}[^"]*)"`).exec(source)?.[1];
  assert(url, `no dev URL for ${file.source} in:\n${source}`);
  return url;
}

/**
 * Load the island's module graph as the browser does (the dev loop hot-updates the modules it
 * served): the island, the UI package it imports by its `@fs` URL, and the package's button.
 */
async function loadIslandGraph(server: Server): Promise<void> {
  const flight = await (await server.get("/_denext/flight.js")).text();
  const counter = await (await server.get(devUrl(flight, /\/counter\.tsx/))).text();
  const mod = await (await server.get(devUrl(counter, /\/packages\/ui\/mod\.ts/))).text();
  const button = await (await server.get(devUrl(mod, /\/packages\/ui\/button\.tsx/))).text();
  assertStringIncludes(button, "ui-button");
}

/** The dev reload stream's events after `act`, until one matches `until` (or a minute passes). */
async function eventsAfter(
  server: Server,
  act: () => Promise<void>,
  until: RegExp,
): Promise<string> {
  const reload = await server.get("/_denext/reload");
  const reader = reload.body!.pipeThrough(new TextDecoderStream()).getReader();
  await new Promise((r) => setTimeout(r, 500));
  await act();
  let events = "";
  const deadline = Date.now() + 60_000;
  while (!until.test(events) && Date.now() < deadline) {
    const timer = new Promise<null>((r) => setTimeout(() => r(null), 5_000));
    const next = await Promise.race([reader.read(), timer]);
    if (next && !next.done) events += next.value;
  }
  await reader.cancel();
  return events;
}

/** Poll `check` until it holds (20 s), or fail. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

/** Every file under `dir` whose text includes `needle` (relative names). */
async function filesWith(dir: string, needle: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".js")) continue;
    if ((await Deno.readTextFile(join(dir, e.name))).includes(needle)) out.push(e.name);
  }
  return out;
}

/** The scaffolded workspace, pointed at this checkout; shared by the steps below. */
async function workspace(): Promise<string> {
  const root = join(
    await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_mono_" })),
    "acme",
  );
  await scaffoldMonorepo({ dir: root, vscode: false });
  await pointAtThisCheckout(root);
  return root;
}

Deno.test({
  name: "denext create --monorepo: check passes, and apps/web builds and serves the packages",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const root = await workspace();
    const web = join(root, "apps/web");
    try {
      await t.step("the root check task: fmt, lint, every member's tests", async () => {
        const out = await deno(["task", "check"], root);
        assertStringIncludes(out, "Button calls onClick ... ok");
        assertStringIncludes(out, "pluralize picks the form for the count ... ok");
      });

      await t.step("apps/web builds, and its server renders the shared packages", async () => {
        await deno(["run", "-A", "--config", join(web, "deno.json"), CLI, "build", "."], web);
        // The client bundle carries the shared Button (the island's import, by package name).
        assert((await filesWith(join(web, ".denext/client"), "ui-button")).length > 0);
        const css = await Deno.readTextFile(join(web, ".denext/client/index.css"));
        assertStringIncludes(css, ".ui-card"); // the package's stylesheet export
        // The start task's own flags, plus --allow-run: this checkout's CLI can't resolve a
        // workspace member's import map (it lies outside the member) and re-runs itself under a
        // merged config, which the published CLI never does.
        const task = JSON.parse(await Deno.readTextFile(join(web, "deno.json"))).tasks.start;
        const flags = (task as string).split(/\s+/).filter((w) => w.startsWith("--allow-"));
        const server = await serve("start", [...flags, "--allow-run"], web);
        try {
          const html = await sharedPage(server);
          assertStringIncludes(html, "/_denext/client/index.css");
        } finally {
          await server.stop();
        }
      });

      await t.step("denext dev in apps/web: per-module packages and HMR across them", async () => {
        const server = await serve("dev", ["-A"], web);
        try {
          await sharedPage(server);
          await loadIslandGraph(server);
          // An edit in packages/ui: the dev loop hot-updates that module.
          const events = await eventsAfter(server, async () => {
            const button = join(root, "packages/ui/button.tsx");
            const source = await Deno.readTextFile(button);
            await Deno.writeTextFile(button, source.replace('"ui-button"', '"ui-button edited"'));
          }, /packages\/ui\/button\.tsx/);
          assertStringIncludes(events, "data: update:", events);
          assertStringIncludes(events, "/packages/ui/button.tsx");
          // And the server render follows.
          await eventually(async () =>
            (await (await server.get("/")).text()).includes("ui-button edited")
          );
        } finally {
          await server.stop();
        }
      });
    } finally {
      await removeTempDir(join(root, ".."));
    }
  },
});
