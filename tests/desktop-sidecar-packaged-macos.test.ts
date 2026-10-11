// A `desktop.sidecars` Node backend in a PACKAGED macOS app (`denext desktop package`, the pinned
// runtime, ad-hoc signed): a throwaway SPA project whose `run: { module, nodeModules, external }`
// sidecar is bundled at packaging (a pure dependency inlined, an `external` one archived in
// `modules.pack` and unpacked into the app's cache folder at launch), started by the packaged app,
// answers its `ready: { http }` probe, is reachable from the page through `spa.proxy`
// (`proxy: true`) with the per-launch secret it shares with the page (`expose`), starts a child of
// the app running its own module headless (`denextSidecar.spawnSelf`: stdin echoed to a stdout free
// of the runtime's start-up lines, its exit code, the unpacked package loaded in the child too), and
// is gone (its port closed) once the page quits the app.
//
// The page reports through the app's own `onRequest` (`/_probe/report`, printed on stdout) and then
// quits with `window.close()`. It opens a real window for a few seconds, so it needs a logged-in
// macOS session, and packaging takes minutes: it runs only on macOS with
// DENEXT_PACKAGED_SIDECAR_TEST=1, e.g.
//
//   DENEXT_PACKAGED_SIDECAR_TEST=1 deno test -A tests/desktop-sidecar-packaged-macos.test.ts
//
// Nothing is signed with a real identity (the package script's ad-hoc signature) and the app uses
// no keychain capability. The project, the bundle and the app's cache / data folders are removed.

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";

const ENABLED = Deno.build.os === "darwin" &&
  (() => {
    try {
      return Deno.env.get("DENEXT_PACKAGED_SIDECAR_TEST") === "1";
    } catch {
      return false;
    }
  })();

const REPO = fromFileUrl(new URL("..", import.meta.url));
const CLI = join(REPO, "cli.ts");
const APP_NAME = "denext sidecar probe";
const IDENTIFIER = "dev.denext.sidecar-probe";
/** How long the packaged app may take to report (its first launch unpacks the modules). */
const REPORT_TIMEOUT_MS = 120_000;

/** The repo module `rel` as an import-map target. */
const repo = (rel: string) => toFileUrl(join(REPO, rel)).href;

/** The throwaway project: path → text. */
function project(): Record<string, string> {
  return {
    "deno.json": JSON.stringify(
      {
        version: "1.0.0",
        tasks: { export: `deno run -A ${JSON.stringify(CLI)} export .` },
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "denext",
          lib: ["deno.window", "dom", "dom.iterable", "dom.asynciterable"],
        },
        imports: {
          "denext": repo("mod.ts"),
          "denext/jsx-runtime": repo("src/jsx/jsx-runtime.ts"),
          "denext/jsx-dev-runtime": repo("src/jsx/jsx-runtime.ts"),
          "denext/server": repo("src/server/mod.ts"),
          "denext/client": repo("src/client/mod.ts"),
          "denext/desktop": repo("src/build/desktop.ts"),
          "denext/desktop/client": repo("src/desktop/client.ts"),
          "@std/path": "jsr:@std/path@^1",
        },
      },
      null,
      2,
    ),
    "denext.config.ts": `export default {
  mode: "spa",
  spa: { entry: "./src/main.ts", title: "sidecar probe", proxy: { prefixes: ["/api"], target: "http://127.0.0.1:1" } },
  desktop: {
    app: { name: ${JSON.stringify(APP_NAME)}, identifier: ${JSON.stringify(IDENTIFIER)} },
    installers: { macos: [], linux: [], windows: [] },
    sidecars: [{
      name: "server",
      run: { module: "./server/main.mjs", nodeModules: "./server/node_modules", external: ["extpkg"] },
      port: "auto",
      ready: { http: "/health", timeoutMs: 30000 },
      secrets: { TOKEN: "$random" },
      expose: { token: "$secret:TOKEN" },
      proxy: true,
      permissions: { run: ["*"] }, // spawnSelf: the app's own executable, whose path is the user's
    }],
  },
};
`,
    "desktop.ts": `import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";

await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
  onRequest: async (request, url) => {
    if (url.pathname !== "/_probe/report" || request.method !== "POST") return null;
    console.log("PROBE_REPORT " + JSON.stringify(await request.json()));
    return new Response(null, { status: 204 });
  },
});
`,
    "src/main.ts": `import { sidecarInfo, sidecarStatus } from "denext/desktop/client";

async function probe() {
  const report = {};
  try {
    const info = await sidecarInfo("server");
    report.info = { state: info.state, port: info.port, url: info.url, hasToken: typeof info.values.token === "string" };
    const res = await fetch("/api/hello", { headers: { "x-probe-token": String(info.values.token) } });
    report.proxied = { status: res.status, body: await res.json() };
    const child = await fetch("/api/child", { headers: { "x-probe-token": String(info.values.token) } });
    report.child = { status: child.status, body: await child.json() };
    report.status = (await sidecarStatus("server")).state;
  } catch (err) {
    report.error = String(err && err.stack || err);
  }
  await fetch("/_probe/report", { method: "POST", body: JSON.stringify(report) });
  document.body.textContent = "reported";
  window.close();
}
probe();
`,
    "server/main.mjs": `import http from "node:http";
import process from "node:process";
import { greet } from "puredep";
import ext from "extpkg";

const sc = globalThis.denextSidecar;
// A child of the app running this module (spawnSelf below): echo stdin, exit with a code.
function childMain() {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => input += d);
  process.stdin.on("end", () => {
    process.stdout.write("child:" + JSON.stringify({ argv: process.argv.slice(2), input, ext: ext.readOwnFile() }) + "\\n");
    process.exitCode = 7;
  });
}
// Start a child of the app and answer with what it did.
function childRoute(res) {
  const child = sc.spawnSelf(["mcp-bridge", "--stdio"]);
  let out = "", err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out += d);
  child.stderr.on("data", (d) => err += d);
  child.on("error", (e) => { err += String(e); });
  child.stdin.end("ping");
  child.on("close", (code) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code, out, err: err.slice(-2000) }));
  });
}
if (sc.child) childMain();
else serve();

function serve() {
const { port, secrets } = sc;
const server = http.createServer((req, res) => {
  if (req.url === "/health") return res.end("ok");
  if (req.url.startsWith("/api/child")) {
    if (req.headers["x-probe-token"] !== secrets.TOKEN) { res.statusCode = 403; return res.end("{}"); }
    return childRoute(res);
  }
  if (req.url.startsWith("/api/hello")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      greet: greet(),
      ext: ext.readOwnFile(),
      tokenMatches: req.headers["x-probe-token"] === secrets.TOKEN,
      port,
    }));
  }
  res.statusCode = 404;
  res.end();
});
server.listen(port, "127.0.0.1", () => console.log("SIDECAR_LISTENING " + port));
}
`,
    "server/node_modules/puredep/package.json":
      '{"name":"puredep","type":"module","exports":"./index.js"}',
    "server/node_modules/puredep/index.js": 'export const greet = () => "hi from puredep";\n',
    "server/node_modules/extpkg/package.json": '{"name":"extpkg","main":"index.js"}',
    "server/node_modules/extpkg/index.js": `const { readFileSync } = require("node:fs");
const { join } = require("node:path");
module.exports = { readOwnFile: () => readFileSync(join(__dirname, "data.txt"), "utf8").trim() };
`,
    "server/node_modules/extpkg/data.txt": "external data\n",
  };
}

/** Write `files` under `root`. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, ...rel.split("/"));
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, text);
  }
}

/** Run a command in `cwd`, failing with its output on a non-zero exit. */
async function run(cmd: string[], cwd: string): Promise<void> {
  const out = await new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    const text = new TextDecoder();
    throw new Error(
      `exit ${out.code}: ${cmd.join(" ")}\n${text.decode(out.stdout)}\n${text.decode(out.stderr)}`,
    );
  }
}

/** The bundle's executable (`CFBundleExecutable`). */
async function macExecutable(app: string): Promise<string> {
  const plist = await Deno.readTextFile(join(app, "Contents", "Info.plist"));
  const exe = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  if (!exe) throw new Error(`no CFBundleExecutable in ${app}`);
  return join(app, "Contents", "MacOS", exe);
}

/** Whether something accepts a TCP connection on loopback `port`. */
async function listening(port: number): Promise<boolean> {
  try {
    (await Deno.connect({ hostname: "127.0.0.1", port })).close();
    return true;
  } catch {
    return false;
  }
}

/** The app's per-user folders the runtime creates for `IDENTIFIER` (removed afterwards). */
function appFolders(): string[] {
  const home = Deno.env.get("HOME");
  if (!home) return [];
  return [
    join(home, "Library", "Caches", IDENTIFIER),
    join(home, "Library", "Application Support", IDENTIFIER),
    join(home, "Library", "WebKit", IDENTIFIER),
  ];
}

Deno.test({
  name: "packaged macOS app: a Node backend sidecar starts, is ready, proxied, and ends on quit",
  ignore: !ENABLED,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "denext-sidecar-packaged-" });
    let child: Deno.ChildProcess | undefined;
    try {
      await writeTree(root, project());
      await run(
        ["deno", "run", "-A", CLI, "desktop", "package", "--regenerate-scripts", "."],
        root,
      );
      await run(["deno", "run", "-A", CLI, "desktop", "package", "."], root);
      const app = join(root, "dist", `${APP_NAME}.app`);
      const exe = await macExecutable(app);

      child = new Deno.Command(exe, {
        cwd: root,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const text = new TextDecoder();
      let output = "";
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        for await (const chunk of stream) output += text.decode(chunk, { stream: true });
      };
      const pumped = Promise.all([pump(child.stdout), pump(child.stderr)]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const status = await Promise.race([
        child.status,
        new Promise<null>((resolve) => timer = setTimeout(() => resolve(null), REPORT_TIMEOUT_MS)),
      ]);
      clearTimeout(timer);
      if (status === null) {
        child.kill("SIGKILL");
        await child.status;
      }
      await Promise.race([pumped, new Promise((resolve) => setTimeout(resolve, 2000))]);
      const tail = `\napp output:\n${output.split("\n").slice(-60).join("\n")}`;
      assert(status !== null, `the app did not quit within ${REPORT_TIMEOUT_MS} ms${tail}`);
      assertEquals(status.code, 0, `the app exited with ${status.code}${tail}`);

      const line = output.split("\n").find((l) => l.startsWith("PROBE_REPORT "));
      assert(line, `the page sent no report${tail}`);
      const report = JSON.parse(line.slice("PROBE_REPORT ".length));
      assertEquals(report.error, undefined, `the page failed${tail}`);
      const port = report.info.port as number;
      assert(Number.isInteger(port) && port > 0, `an "auto" port: ${JSON.stringify(report)}`);
      assertEquals(report.info, {
        state: "ready",
        port,
        url: `http://127.0.0.1:${port}`,
        hasToken: true,
      });
      assertEquals(report.status, "ready");
      // Through spa.proxy: the inlined dependency, the external one read from its unpacked
      // folder, and the per-launch secret the page got from sidecarInfo matching the sidecar's.
      assertEquals(report.proxied, {
        status: 200,
        body: { greet: "hi from puredep", ext: "external data", tokenMatches: true, port },
      });
      // A child of the app ran the bundled module headless: argv, stdin echoed on a stdout free of
      // the runtime's start-up lines, the external package from the unpacked folder, exit code 7.
      assertEquals(report.child, {
        status: 200,
        body: {
          code: 7,
          out: 'child:{"argv":["mcp-bridge","--stdio"],"input":"ping","ext":"external data"}\n',
          err: report.child?.body?.err,
        },
      }, `the child${tail}`);
      assert(output.includes(`[sidecar:server] SIDECAR_LISTENING ${port}`), `log${tail}`);
      // The worker ended with the app: nothing listens on its port any more.
      assertEquals(await listening(port), false, `port ${port} still open after the app quit`);
    } finally {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
      }
      await Deno.remove(root, { recursive: true }).catch(() => {});
      for (const dir of appFolders()) await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
