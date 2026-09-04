// Guards the "denext runs from JSR, not a local checkout" build path (the frameworkRoot fix).
//
// A consumer's migrated app runs `deno run -A jsr:@denext/denext/cli build .`, where every
// framework module's `import.meta.url` is `https://…` — not `file://`. The normal test suite
// always uses a local (file://) framework and CANNOT catch a re-introduced `file://`
// assumption (e.g. `fromFileUrl(import.meta.url)` / `join(frameworkRoot(), …)` + readTextFile).
//
// `http://` triggers the identical non-file:// code path as JSR's `https://`, so this serves
// the repo over http and builds a minimal app through `http://…/cli.ts`. A green build here
// means it builds from JSR too. See CONTRIBUTING.md → "The build must run from a remote
// framework".
//
// Opt-in + NETWORK (the @std/http/file-server import is fetched once). Skipped if it can't start.

import { assert } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { killTree } from "./harness.ts";

const REPO = fromFileUrl(new URL("../../", import.meta.url));
const DENO = Deno.execPath();
const READY_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 180_000;

/** A minimal native App Router app that imports denext from `origin` (the http-served repo). */
async function writeMinimalApp(app: string, origin: string): Promise<void> {
  await Deno.writeTextFile(
    `${app}/deno.json`,
    JSON.stringify({
      imports: { "denext": `${origin}/mod.ts`, "denext/": `${origin}/` },
      compilerOptions: { jsx: "react-jsx", jsxImportSource: "denext" },
    }),
  );
  await Deno.mkdir(`${app}/app`);
  await Deno.writeTextFile(
    `${app}/app/page.tsx`,
    `export default function Home() { return <h1>remote build ok</h1>; }`,
  );
}

/**
 * Build `app` through the http-served CLI (import.meta.url is http:// → the remote path).
 * --reload so edits to the framework are always re-fetched; --no-lock to avoid a stale
 * integrity pin; --config so the framework's own imports (@std/…) resolve.
 */
async function buildViaRemoteCli(
  app: string,
  origin: string,
): Promise<{ success: boolean; out: string }> {
  const build = new Deno.Command(DENO, {
    args: [
      "run",
      `--reload=${origin}`,
      "--no-lock",
      "--allow-all",
      `--config=${REPO}deno.json`,
      `${origin}/cli.ts`,
      "build",
      app,
    ],
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(BUILD_TIMEOUT_MS),
  });
  const { success, stdout, stderr } = await build.output();
  const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
  return { success, out };
}

Deno.test({
  name: "e2e: a migrated app builds when denext is loaded remotely (run-from-JSR path)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // 1. Serve the repo over http on an ephemeral port.
  const server = new Deno.Command(DENO, {
    args: ["run", "--allow-read", "--allow-net", "jsr:@std/http/file-server", "--port", "0", REPO],
    stdout: "piped",
    stderr: "null",
  }).spawn();

  const app = await Deno.makeTempDir({ prefix: "denext_remote_fw_" });
  try {
    const origin = await readServerOrigin(server.stdout);
    if (!origin) {
      console.warn("e2e: file-server did not start (offline?) — skipping.");
      return;
    }

    // 2. A minimal native App Router app.
    await writeMinimalApp(app, origin);

    // 3. Build through the http-served CLI.
    const { success, out } = await buildViaRemoteCli(app, origin);
    assert(success, `remote build failed:\n${out}`);
    // The bug manifested as this exact message before the fix.
    assert(
      !out.includes("URL must be a file URL"),
      `frameworkRoot hit a file:// assumption:\n${out}`,
    );
    assert((await Deno.stat(`${app}/.denext`)).isDirectory, "no .denext output produced");
  } finally {
    await killTree(server.pid);
    try {
      await server.status;
    } catch { /* already reaped */ }
    await Deno.remove(app, { recursive: true }).catch(() => {});
  }
});

/** Read the file-server's stdout for its "Listening on http://host:port" line, bounded. */
async function readServerOrigin(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => reader.cancel().catch(() => {}), READY_TIMEOUT_MS);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return "";
      buf += decoder.decode(value, { stream: true });
      const m = buf.match(/https?:\/\/[^/\s]+/);
      if (m) return m[0];
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
