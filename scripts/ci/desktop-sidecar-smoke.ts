// CI test of `desktop.sidecars` in a PACKAGED desktop app (Linux under Xvfb, macOS): a tiny app
// with two sidecars, packaged with the scaffolded script on denext's pinned runtime, then launched.
//
// - `api`: a Node-style backend (`node:http`, an npm dependency from its own `node_modules`, so it
//   is bundled into `.deno-desktop/sidecars/api/`) running in a worker of the app's own runtime,
//   on an `"auto"` loopback port, ready when `/health` answers. It must serve, survive an uncaught
//   error by being restarted on the same port (the app stays up), and be gone with the app.
// - `prog`: a program (a shell script of the project, embedded in the binary and run from a copy
//   in the app's cache folder) that reads the hello line on stdin and stays until stdin closes.
//   After the app is killed with SIGKILL it must be gone too: its stdin closed with the app.
//
//   deno run -A scripts/ci/desktop-sidecar-smoke.ts

import { join } from "@std/path";
import {
  DESKTOP_RUNTIME_CONFIG_FILE,
  desktopRuntimeConfigText,
} from "../../src/build/desktop-app-config.ts";
import {
  copyDenext,
  denextDenoJson,
  packageApp,
  report,
  requireMacOrLinux,
} from "./_packaged-app.ts";

const APP_NAME = "sidecar-smoke";
const TIMEOUT_MS = Number(Deno.env.get("DESKTOP_SIDECAR_SMOKE_TIMEOUT_MS") ?? 120_000);

requireMacOrLinux("desktop-sidecar-smoke");

/** The app's config: the two sidecars, `spa.proxy` for the proxied one. */
const CONFIG = {
  spa: { proxy: { target: "http://127.0.0.1:1", prefixes: ["/api"] } },
  desktop: {
    app: { name: APP_NAME, identifier: "dev.denext.sidecar-smoke" },
    installers: { macos: [], linux: [], windows: [] },
    sidecars: [
      {
        name: "api",
        run: { module: "sidecar/server.mjs", nodeModules: "sidecar/node_modules" },
        port: "auto",
        env: { GREETING: "hello from the sidecar" },
        ready: { http: "/health", timeoutMs: 20_000 },
        restart: { backoffMs: 200 },
        proxy: true,
      },
      { name: "prog", run: { exec: "./bin/prog.sh" }, args: ["--marker", "sidecar-smoke-prog"] },
    ],
  },
};

/** Write the app (deno.json maps denext to `denext`, a copy of this checkout). */
async function writeApp(app: string, denext: string): Promise<void> {
  const { compilerOptions, imports } = await denextDenoJson(denext);
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({ compilerOptions, imports, desktop: { app: CONFIG.desktop.app } }, null, 2),
  );
  await Deno.writeTextFile(
    join(app, "denext.config.ts"),
    `export default ${JSON.stringify(CONFIG)};\n`,
  );
  await Deno.mkdir(join(app, ".deno-desktop"), { recursive: true });
  await Deno.writeTextFile(
    join(app, DESKTOP_RUNTIME_CONFIG_FILE),
    desktopRuntimeConfigText(CONFIG),
  );
  await Deno.writeTextFile(
    join(app, "desktop.ts"),
    'import config from "./.deno-desktop/config.json" with { type: "json" };\n' +
      'import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";\n' +
      "const app = await runDesktop({\n" +
      "  importMetaUrl: import.meta.url,\n" +
      "  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),\n" +
      "});\n" +
      'app.sidecar("api").onStatus((s) => console.error(`smoke: api ${s.state}`));\n',
  );
  const files: Record<string, string> = {
    "sidecar/server.mjs": `import http from "node:http";
import { shout } from "smoke-dep";
const server = http.createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  if (req.url === "/crash") { res.end("bye"); setTimeout(() => { throw new Error("smoke crash"); }, 20); return; }
  res.end(JSON.stringify({ greeting: shout(process.env.GREETING), port: globalThis.denextSidecar.port }));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
`,
    "sidecar/package.json":
      '{"name":"smoke-sidecar","type":"module","dependencies":{"smoke-dep":"1"}}',
    "sidecar/node_modules/smoke-dep/package.json":
      '{"name":"smoke-dep","version":"1.0.0","type":"module","exports":"./index.js"}',
    "sidecar/node_modules/smoke-dep/index.js":
      "export const shout = (s) => String(s).toUpperCase();\n",
    "bin/prog.sh":
      '#!/bin/sh\nread -r hello\necho "prog got $hello"\nwhile read -r _; do :; done\necho "prog stdin closed"\n',
    "out/index.html": "<!doctype html><title>sidecar smoke</title><p>ok</p>\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    const path = join(app, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
  await Deno.chmod(join(app, "bin", "prog.sh"), 0o755);
}

/** Whether a process whose command line contains `needle` is running (`ps`). */
async function running(needle: string): Promise<boolean> {
  const { stdout } = await new Deno.Command("ps", { args: ["-eo", "args"], stdout: "piped" })
    .output();
  return new TextDecoder().decode(stdout).split("\n").some((l) =>
    l.includes(needle) && !l.includes("ps -eo")
  );
}

/** GET `url` as text, or `null` when nothing answers. */
async function get(url: string): Promise<{ status: number; text: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const scratch = await Deno.makeTempDir({ prefix: "denext-sidecar-smoke-" });
const denext = join(scratch, "denext");
const app = join(scratch, "app");
const problems: string[] = [];
let child: Deno.ChildProcess | undefined;
try {
  await Deno.mkdir(app);
  await copyDenext(denext);
  await writeApp(app, denext);
  const exe = await packageApp(app, APP_NAME);

  child = new Deno.Command(exe, { stdin: "null", stdout: "piped", stderr: "piped" }).spawn();
  let output = "";
  const decoder = new TextDecoder();
  const pump = async (
    stream: ReadableStream<Uint8Array>,
    sink: { writeSync(b: Uint8Array): number },
  ) => {
    for await (const chunk of stream) {
      sink.writeSync(chunk);
      output += decoder.decode(chunk, { stream: true });
    }
  };
  const pumps = Promise.all([pump(child.stdout, Deno.stdout), pump(child.stderr, Deno.stderr)]);
  const waitFor = async (re: RegExp, after = 0): Promise<RegExpExecArray | null> => {
    const end = Date.now() + TIMEOUT_MS;
    while (Date.now() < end) {
      const m = re.exec(output.slice(after));
      if (m) return m;
      await sleep(100);
    }
    return null;
  };

  const ready = await waitFor(/desktop: sidecar api ready on 127\.0\.0\.1:(\d+)/);
  if (!ready) throw new Error("the api sidecar never became ready");
  const port = Number(ready[1]);
  const first = await get(`http://127.0.0.1:${port}/`);
  if (first?.text !== JSON.stringify({ greeting: "HELLO FROM THE SIDECAR", port })) {
    problems.push(`the api sidecar answered ${JSON.stringify(first)}`);
  }
  if (!await waitFor(/\[sidecar:prog\] prog got \{"name":"prog","port":null/)) {
    problems.push("the program sidecar did not get its hello line");
  }
  if (!await running("sidecar-smoke-prog")) problems.push("the program sidecar is not running");

  // An uncaught error ends the worker, not the app: it is restarted on the same port.
  const before = output.length;
  await get(`http://127.0.0.1:${port}/crash`);
  if (!await waitFor(/smoke: api backoff/, before)) problems.push("the crash was not seen");
  if (!await waitFor(/desktop: sidecar api ready on 127\.0\.0\.1:\d+/, before)) {
    problems.push("the api sidecar was not restarted");
  }
  if ((await get(`http://127.0.0.1:${port}/health`))?.text !== "ok") {
    problems.push("the restarted api sidecar does not answer on its port");
  }
  if (/NotCapable/.test(output)) problems.push("the app hit a permission error (NotCapable)");

  // Kill the app outright: neither sidecar may outlive it.
  child.kill("SIGKILL");
  await child.status;
  child = undefined;
  await Promise.race([pumps, sleep(3000)]);
  await sleep(1500);
  if (await get(`http://127.0.0.1:${port}/health`)) {
    problems.push("the api sidecar outlived the app");
  }
  if (await running("sidecar-smoke-prog")) problems.push("the program sidecar outlived the app");
} catch (err) {
  problems.push(err instanceof Error ? err.message : String(err));
} finally {
  try {
    child?.kill("SIGKILL");
  } catch { /* gone */ }
  await Deno.remove(scratch, { recursive: true }).catch(() => {});
}

report(
  "desktop sidecar smoke",
  problems,
  "bundled, served, restarted after a crash, gone with the app",
);
Deno.exit(0);
