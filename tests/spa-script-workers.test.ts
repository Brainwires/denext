// `<Script strategy="worker">` in SPA mode (src/build/spa/script-workers.ts): a SPA renders
// `<Script>` in the browser, where it takes the nonce the Partytown boot ran with. So when denext
// serves the SPA (`denext dev`, `denext start`) and `nextScriptWorkers` is on with Partytown
// published, every shell response mints its own nonce: the boot tag and the shell's scripts carry
// it and the `spa.csp` policy lists it. Without that, and in a static export, worker scripts keep
// the main-thread fallback.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startSpaProdServer } from "../src/build/spa.ts";
import { stampWorkerNonce } from "../src/build/spa/script-workers.ts";

const LIB = "/_denext/~partytown/";

const CSP_SHELL = `<!doctype html><html><head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; ` +
  `script-src &#39;self&#39; &#39;sha256-abc=&#39;; style-src &#39;self&#39;" />
  </head><body><div id="root"></div>
    <script>window.boot = 1</script>
    <script type="module" src="/_denext/client/index.js"></script>
  </body></html>`;

Deno.test("stampWorkerNonce: the boot tag, the shell's scripts and the CSP carry the nonce", () => {
  const out = stampWorkerNonce(CSP_SHELL, LIB, "n0nce");
  assertStringIncludes(out, `script-src 'nonce-n0nce' &#39;self&#39; &#39;sha256-abc=&#39;`);
  assertStringIncludes(out, `<script nonce="n0nce">window.boot = 1</script>`);
  assertStringIncludes(
    out,
    `<script nonce="n0nce" type="module" src="/_denext/client/index.js"></script>`,
  );
  // The boot is the last thing in <head>: after the policy, before every body script.
  const boot = `<script src="${LIB}boot.js" nonce="n0nce"></script>`;
  assert(out.indexOf(boot) > out.indexOf("Content-Security-Policy"));
  assert(out.indexOf(boot) < out.indexOf("</head>"));
  assertEquals(out.split("nonce=").length - 1, 3);
  // A script that names its own nonce keeps it; no policy, no policy edit.
  const own = stampWorkerNonce(`<head></head><script nonce="x"></script>`, LIB, "n");
  assertStringIncludes(own, `<script nonce="x"></script>`);
  assert(!own.includes("nonce-n"));
});

/** A built SPA (shell, bundle, and the Partytown directory the build publishes). */
async function builtSpa(config: string, partytown: boolean): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_spa_workers_" });
  await Deno.writeTextFile(join(dir, "denext.config.ts"), `export default ${config};\n`);
  const client = join(dir, ".denext", "client");
  await Deno.mkdir(join(client, "_partytown"), { recursive: true });
  await Deno.writeTextFile(join(client, "index.html"), CSP_SHELL);
  await Deno.writeTextFile(join(client, "index.js"), "console.log(1);\n");
  if (partytown) {
    await Deno.writeTextFile(join(client, "_partytown", "boot.js"), "/* boot */\n");
  }
  return dir;
}

async function withServer(dir: string, fn: (origin: string) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  const { promise, resolve } = Promise.withResolvers<{ hostname: string; port: number }>();
  const server = await startSpaProdServer({
    projectDir: dir,
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: resolve,
  });
  const { hostname, port } = await promise;
  try {
    await fn(`http://${hostname}:${port}`);
  } finally {
    controller.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true });
  }
}

const SPA = `mode: "spa", spa: { entry: "./main.tsx", csp: "strict" }`;
const html = (url: string) => fetch(url, { headers: { accept: "text/html" } });
const nonceOf = (body: string) => body.match(/boot\.js" nonce="([0-9a-f]{32})"/)?.[1];

Deno.test("SPA start: each shell response mints its own worker-script nonce", async () => {
  const dir = await builtSpa(`{ ${SPA}, nextScriptWorkers: true }`, true);
  await withServer(dir, async (origin) => {
    const first = await (await html(origin + "/")).text();
    const second = await (await html(origin + "/deep/link")).text();
    const a = nonceOf(first), b = nonceOf(second);
    assert(a && b, "both responses carry a boot tag with a nonce");
    assertNotEquals(a, b, "a nonce is never reused across responses");
    assertStringIncludes(first, `script-src 'nonce-${a}'`);
    assertStringIncludes(first, `<script nonce="${a}" type="module"`);
    const boot = await fetch(origin + `${LIB}boot.js`);
    assertEquals(boot.status, 200);
    assertEquals(await boot.text(), "/* boot */\n");
  });
});

Deno.test("SPA start: no flag, or no published Partytown, serves the shell as built", async () => {
  for (
    const [config, published] of [[`{ ${SPA} }`, true], [
      `{ ${SPA}, nextScriptWorkers: true }`,
      false,
    ]] as const
  ) {
    const dir = await builtSpa(config, published);
    await withServer(dir, async (origin) => {
      assertEquals(await (await html(origin + "/")).text(), CSP_SHELL);
      const boot = await fetch(origin + `${LIB}boot.js`, { headers: { accept: "text/html" } });
      assert(!(await boot.text()).includes("/* boot */"), "nothing published to serve");
    });
  }
});
