// `@denext/ui` is loaded on first use by a literal dynamic import pinned to denext's own version
// (src/cli/ui-package.ts): from the workspace member in a checkout, from JSR (or Deno's cache)
// elsewhere. A load that cannot reach JSR stops the verb with what to do, not Deno's loader error.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import {
  isModuleLoadFailure,
  loadUiPackage,
  UI_PACKAGE,
  uiUnavailableMessage,
} from "../src/cli/ui-package.ts";
import { VERSION } from "../src/version.ts";
import { DASH_MIN_PASSWORD, DEFAULT_RELAY_PORT, DEFAULT_UI_PORT } from "../src/ui/constants.ts";

Deno.test("ui package: the workspace member loads, once per process, with the CLI's defaults", async () => {
  const first = loadUiPackage("denext ui");
  assert(first === loadUiPackage("denext dashboard"), "one load per process");
  const ui = await first;
  assertEquals(typeof ui.startUiServer, "function");
  assertEquals(typeof ui.startLogsRelay, "function");
  // The CLI names these before it loads the UI; the package re-exports the same values.
  assertEquals(ui.DEFAULT_UI_PORT, DEFAULT_UI_PORT);
  assertEquals(ui.DASH_MIN_PASSWORD, DASH_MIN_PASSWORD);
  assertEquals(ui.DEFAULT_RELAY_PORT, DEFAULT_RELAY_PORT);
});

Deno.test("ui package: a failed fetch names the package, the version and the way out", async () => {
  const fetchFailed = new TypeError(
    "Import 'https://jsr.io/@denext/ui/meta.json' failed.\n    0: error sending request for url",
  );
  const err = await assertRejects(
    () => loadUiPackage("denext ui", () => Promise.reject(fetchFailed)),
    Error,
  );
  assert(err.message.startsWith("denext: "), "printed without a stack trace (cli.ts)");
  assertStringIncludes(err.message, `denext ui needs ${UI_PACKAGE}@${VERSION}`);
  assertStringIncludes(err.message, "failed. 0: error sending request"); // on one line
  assertStringIncludes(err.message, "then works offline");
  assertStringIncludes(err.message, `deno cache jsr:${UI_PACKAGE}@${VERSION}`);
  assertEquals(err.cause, fetchFailed);
});

Deno.test("ui package: an error from the UI's own code is not reported as a failed fetch", async () => {
  const bug = new RangeError("the UI threw while loading");
  const err = await assertRejects(() => loadUiPackage("denext ui", () => Promise.reject(bug)));
  assert(err === bug, "propagated unchanged");
  assert(!isModuleLoadFailure(bug));
  assert(!isModuleLoadFailure(new TypeError("x is not a function")));
  assert(isModuleLoadFailure(new TypeError('Module not found "jsr:@denext/ui@1.0.0".')));
  assertStringIncludes(uiUnavailableMessage("denext dashboard", "offline"), "(offline)");
});

/** A Deno child importing `jsr:@denext/ui@<VERSION>` through the loader, against `jsrUrl`. */
async function childLoad(jsrUrl: string): Promise<{ code: number; stderr: string }> {
  const dir = await Deno.makeTempDir();
  try {
    const loader = toFileUrl(join(Deno.cwd(), "src/cli/ui-package.ts")).href;
    await Deno.writeTextFile(
      join(dir, "main.ts"),
      `import { loadUiPackage } from ${JSON.stringify(loader)};\n` +
        `try {\n` +
        `  await loadUiPackage("denext ui", () => import("jsr:@denext/ui@${VERSION}"));\n` +
        `} catch (error) {\n` +
        `  console.error((error as Error).message);\n` +
        `  Deno.exit(3);\n` +
        `}\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--no-lock", "--allow-read", "--allow-net", "main.ts"],
      cwd: dir,
      // An empty cache, so the import must reach the (fake) registry.
      env: { JSR_URL: jsrUrl, DENO_DIR: join(dir, "deno-dir"), NO_COLOR: "1" },
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).output();
    return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("ui package: offline (JSR unreachable), a real Deno load stops with the message", async () => {
  // A port nothing listens on: the connection is refused, as with no network.
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const { code, stderr } = await childLoad(`http://127.0.0.1:${port}/`);
  assertEquals(code, 3, stderr);
  assertStringIncludes(stderr, `denext: denext ui needs ${UI_PACKAGE}@${VERSION}`);
  assertStringIncludes(stderr, "then works offline");
});

Deno.test("ui package: a JSR that answers with an error stops with the message too", async () => {
  const requests: string[] = [];
  await using server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (req) => {
    requests.push(new URL(req.url).pathname);
    return new Response("unavailable", { status: 503 });
  });
  const { code, stderr } = await childLoad(`http://127.0.0.1:${server.addr.port}/`);
  assertEquals(code, 3, stderr);
  assertStringIncludes(stderr, `denext: denext ui needs ${UI_PACKAGE}@${VERSION}`);
  assert(requests.some((p) => p.startsWith(`/${UI_PACKAGE}/`)), requests.join(", "));
});
