// Guards the "migrated pnpm SPA built by the JSR-installed CLI" path end to end — the exact
// shape `denext migrate` produces for a Vite + React monorepo app (T3 Code): `mode: "spa"`,
// `compatibilityMode: true`, `nodeModulesDir: "manual"` with a real `node_modules`, a workspace
// package that imports ITSELF by name through its `exports`, and the CLI loaded from a REMOTE
// root (http:// stands in for JSR's https://).
//
// Each of these broke a real migration once:
//   • the compat runtime prebuild turned the remote framework root into a filesystem path
//     ("Path must be absolute: received https://jsr.io/…");
//   • the CLI ran under the app's manual node_modules, so its own `esbuild` import failed at
//     load — the generated tasks now pass `--node-modules-dir=none` for the CLI process;
//   • a workspace package's self-reference (`@acme/lib/util` from inside `packages/lib`) was
//     unresolvable because pnpm links a package into its consumers' node_modules, not its own.
//
// Opt-in + NETWORK (the @std/http/file-server import is fetched once). Skipped if it can't start.

import { assert, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { killTree } from "./harness.ts";

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const DENO = Deno.execPath();
const READY_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 240_000;

/** A pnpm-shaped monorepo: `apps/web` (the migrated SPA) + `packages/lib` (a workspace dep). */
async function writeMonorepo(root: string, origin: string): Promise<string> {
  const app = join(root, "apps", "web");
  const lib = join(root, "packages", "lib");
  await Deno.mkdir(join(app, "src"), { recursive: true });
  await Deno.mkdir(join(lib, "src", "deep"), { recursive: true });
  // The workspace package imports itself by name (Node self-reference via `exports`).
  await Deno.writeTextFile(
    join(lib, "package.json"),
    JSON.stringify({
      name: "@acme/lib",
      version: "0.0.0",
      exports: { ".": "./src/index.ts", "./util": "./src/util.ts" },
    }),
  );
  await Deno.writeTextFile(join(lib, "src", "util.ts"), `export const UTIL_MARKER = "util-ok";`);
  await Deno.writeTextFile(
    join(lib, "src", "deep", "greeting.ts"),
    `import { UTIL_MARKER } from "@acme/lib/util";\nexport const greeting = "hello-" + UTIL_MARKER;`,
  );
  await Deno.writeTextFile(
    join(lib, "src", "index.ts"),
    `export { greeting } from "./deep/greeting.ts";`,
  );
  // pnpm links the workspace package into the CONSUMER's node_modules only.
  await Deno.mkdir(join(app, "node_modules", "@acme"), { recursive: true });
  await Deno.symlink(lib, join(app, "node_modules", "@acme", "lib"));
  await Deno.writeTextFile(
    join(app, "package.json"),
    JSON.stringify({ name: "web", private: true, dependencies: { "@acme/lib": "workspace:*" } }),
  );
  // What `denext migrate` writes for a pnpm SPA (the `denext`/`react` aliases point at the
  // http-served framework here instead of jsr:@denext/denext@^2).
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({
      nodeModulesDir: "manual",
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" },
      imports: {
        "denext": `${origin}/mod.ts`,
        "denext/": `${origin}/`,
        "denext/server": `${origin}/src/server/mod.ts`,
        "react": `${origin}/src/compat/react.ts`,
        "react-dom": `${origin}/src/compat/react-dom.ts`,
        "react-dom/client": `${origin}/src/compat/react-dom-client.ts`,
        "react/jsx-runtime": `${origin}/src/jsx/jsx-runtime.ts`,
        "react/jsx-dev-runtime": `${origin}/src/jsx/jsx-runtime.ts`,
        "~/": "./src/",
      },
    }),
  );
  await Deno.writeTextFile(
    join(app, "denext.config.ts"),
    `export default { mode: "spa", compatibilityMode: true, spa: { entry: "./src/main.tsx", title: "Remote SPA" } };\n`,
  );
  await Deno.writeTextFile(
    join(app, "src", "main.tsx"),
    `import { createRoot } from "react-dom/client";\nimport { greeting } from "@acme/lib";\n` +
      `createRoot(document.getElementById("root")!).render(<h1>{greeting}</h1>);\n`,
  );
  return app;
}

/** Build `app` through the http-served CLI, the way a migrated app's `deno task export` does. */
async function exportViaRemoteCli(
  app: string,
  origin: string,
): Promise<{ success: boolean; out: string }> {
  const build = new Deno.Command(DENO, {
    args: [
      "run",
      "-A",
      // What the generated tasks pass for a manual-node_modules app: the CLI process itself
      // must not resolve ITS npm deps from the app's node_modules.
      "--node-modules-dir=none",
      `--reload=${origin}`,
      "--no-lock",
      `--config=${REPO}deno.json`,
      `${origin}/cli.ts`,
      "export",
      app,
    ],
    cwd: app,
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
  });
  const { success, stdout, stderr } = await build.output();
  const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  return { success, out };
}

Deno.test({
  name: "e2e: a migrated pnpm compat SPA exports through a REMOTE (JSR-shaped) denext",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const server = new Deno.Command(DENO, {
    args: ["run", "--allow-read", "--allow-net", "jsr:@std/http/file-server", "--port", "0", REPO],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "denext_remote_spa_" }));
  try {
    const origin = await readServerOrigin(server.stdout);
    if (!origin) {
      console.warn("e2e: file-server did not start (offline?) — skipping.");
      return;
    }
    const app = await writeMonorepo(root, origin);
    const { success, out } = await exportViaRemoteCli(app, origin);
    assert(success, `remote compat SPA export failed:\n${out}`);
    assert(!out.includes("Path must be absolute"), `remote root treated as a path:\n${out}`);
    assert(!out.includes("Could not find a matching package"), `CLI deps from app tree:\n${out}`);
    const bundle = await Deno.readTextFile(join(app, "out", "_denext", "client", "index.js"));
    assertStringIncludes(bundle, "util-ok", "the workspace package's self-reference bundled");
  } finally {
    await killTree(server.pid);
    try {
      await server.status;
    } catch { /* already reaped */ }
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

/** The first `Listening on:`/`Local:` URL the file-server prints, or "" on timeout. */
async function readServerOrigin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), READY_TIMEOUT_MS)
      ),
    ]);
    if (done) break;
    buf += decoder.decode(value);
    const m = buf.match(/http:\/\/[^\s]+/);
    if (m) {
      reader.releaseLock();
      return m[0].replace("0.0.0.0", "127.0.0.1").replace(/\/$/, "");
    }
  }
  reader.releaseLock();
  return "";
}
