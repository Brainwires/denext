// `<Script strategy="worker">` in SPA mode (src/build/spa/script-workers.ts): a SPA renders
// `<Script>` in the browser, where it takes the nonce the Partytown boot ran with. So when denext
// serves the SPA (`denext dev`, `denext start`) and `nextScriptWorkers` is on with Partytown
// published, every shell response mints its own nonce: the boot tag and the shell's scripts carry
// it and the `spa.csp` policy lists it. Without that, and in a static export, worker scripts keep
// the main-thread fallback.

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { startSpaProdServer } from "../src/build/spa.ts";
import { stampWorkerNonce, stampWorkerNonceBody } from "../src/build/spa/script-workers.ts";
import { spaShellHtml } from "../src/build/spa/shared.ts";

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
    `<script type="module" src="/_denext/client/index.js" nonce="n0nce"></script>`,
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

Deno.test("stampWorkerNonce: markup inside a script, a style or a comment is text, not a tag", () => {
  // An inline script that writes a `<script>` tag of its own: stamping `nonce="…"` into its string
  // literal would end the string early and break the script.
  const inline = `<script>document.head.insertAdjacentHTML("beforeend", ` +
    `"<script src=/x.js><\\/script>"); var t = "</head>";</script>`;
  const shell = `<html><head>${inline}<style>a::after { content: "<script>" }</style>` +
    `<!-- <script src="/old.js"></script> --></head><body>` +
    `<script data-note="a > b" src="/a.js"></script></body></html>`;
  const out = stampWorkerNonce(shell, LIB, "n0nce");
  assertStringIncludes(
    out,
    `<script nonce="n0nce">document.head.insertAdjacentHTML("beforeend", ` +
      `"<script src=/x.js><\\/script>"); var t = "</head>";</script>`,
  );
  assertStringIncludes(out, `<style>a::after { content: "<script>" }</style>`);
  assertStringIncludes(out, `<!-- <script src="/old.js"></script> -->`);
  assertStringIncludes(out, `<script data-note="a > b" src="/a.js" nonce="n0nce"></script>`);
  // The boot goes before the real `</head>`, not the one in the script's string.
  const boot = `<script src="${LIB}boot.js" nonce="n0nce"></script>`;
  assertEquals(out.indexOf(boot), out.indexOf("-->") + 3);
  assertEquals(out.split("nonce=").length - 1, 3);
});

Deno.test("stampWorkerNonce: a stamped tag is written as HTMLRewriter writes it", () => {
  // `<script/>` is not self-closing in HTML: its text runs to the end, so it goes last.
  const shell = `<html><head><script src='/a.js'  data-x=1\n   async ></script>` +
    `<meta content='script-src &#39;self&#39; "q"' http-equiv="Content-Security-Policy">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src x"></head>` +
    `<body><SCRIPT type = "module"/>`;
  assertEquals(
    stampWorkerNonce(shell, LIB, "n"),
    `<html><head><script src='/a.js' data-x=1 async nonce="n"></script>` +
      `<meta content="script-src 'nonce-n' &#39;self&#39; &quot;q&quot;" ` +
      `http-equiv="Content-Security-Policy">` +
      // No `script-src` to list the nonce in: the tag stays as written.
      `<meta http-equiv="Content-Security-Policy" content="default-src x">` +
      `<script src="${LIB}boot.js" nonce="n"></script>\n  </head>` +
      `<body><SCRIPT type = "module" nonce="n" />`,
  );
});

Deno.test("stampWorkerNonceBody: without DENEXT_HTML_REWRITER=1, the string path's string", () => {
  const before = Deno.env.get("DENEXT_HTML_REWRITER");
  try {
    for (const value of [undefined, "0", "true"]) {
      if (value === undefined) Deno.env.delete("DENEXT_HTML_REWRITER");
      else Deno.env.set("DENEXT_HTML_REWRITER", value);
      assertEquals(
        stampWorkerNonceBody(CSP_SHELL, LIB, "n"),
        stampWorkerNonce(CSP_SHELL, LIB, "n"),
      );
    }
  } finally {
    if (before === undefined) Deno.env.delete("DENEXT_HTML_REWRITER");
    else Deno.env.set("DENEXT_HTML_REWRITER", before);
  }
});

Deno.test("stampWorkerNonceBody: not opted in, the shell is never scanned for its <head>", () => {
  // The default path checks the opt-in before it runs the streaming path's shell regexes.
  const before = Deno.env.get("DENEXT_HTML_REWRITER");
  Deno.env.delete("DENEXT_HTML_REWRITER");
  try {
    const shell = Object.assign(new String(CSP_SHELL), {
      match(): never {
        throw new Error("the shell was scanned");
      },
    }) as unknown as string;
    assertEquals(stampWorkerNonceBody(shell, LIB, "n"), stampWorkerNonce(CSP_SHELL, LIB, "n"));
  } finally {
    if (before !== undefined) Deno.env.set("DENEXT_HTML_REWRITER", before);
  }
});

Deno.test("stampWorkerNonce: every CSP <meta> of the shell lists the nonce", () => {
  const shell = `<html><head>` +
    `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">` +
    `<meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head></html>`;
  const out = stampWorkerNonce(shell, LIB, "n");
  assertStringIncludes(out, `content="script-src 'nonce-n' 'self'"`);
  assertStringIncludes(out, `content="script-src 'nonce-n' 'none'"`);
});

/** Shells the byte-equality check stamps on both paths: built ones and hand-written edge cases. */
async function stampCorpus(): Promise<string[]> {
  const built = (spa: Record<string, unknown>, devScriptSrc?: string) =>
    spaShellHtml({
      spa: { entry: "./main.tsx", ...spa },
      scriptSrc: "/_denext/client/index.js",
      styleHref: "/_denext/client/index.css",
      devScriptSrc,
      preload: ["/_denext/client/chunk-a.js"],
    });
  return [
    CSP_SHELL,
    await built({ csp: "strict" }),
    await built({ csp: "strict", title: "A & B" }, "/_denext/dev/reload.js"),
    await built({
      head: `<script>window.a = "<script></script>"</script>` +
        `<script type=module src=/m.js></script><script async\nsrc='/x.js' ></script>` +
        `<script nonce="own"></script><!-- <script src="/old.js"></script> -->` +
        `<style>a::after { content: "<script>" }</style><title>t <script></title>`,
      loading: `<p>Loading…</p><script>document.title = "<b>"</script>`,
    }),
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta content='script-src &#39;self&#39; "q"' http-equiv="Content-Security-Policy">` +
    `<script src='/a.js'  data-x=1\n   async ></script></head>` +
    `<body><textarea><script></textarea><script>1</script></body></html><SCRIPT type = "module"/>`,
    // No `</head>`, or two: the boot has one place to go only on the string path.
    `<html><body><script src="/a.js"></script></body></html>`,
    `<head></head><head></head><body><script></script></body>`,
  ];
}

/** Stamp `shells` in a child with `--unstable-html-rewriter` and `DENEXT_HTML_REWRITER=<env>`. */
async function stampInChild(shells: string[], env: string) {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-html-rewriter",
      new URL("./fixtures/html-rewriter/stamp.ts", import.meta.url).pathname,
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: { DENEXT_HTML_REWRITER: env },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(shells)));
  await writer.close();
  const out = await child.output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout)) as {
    rewriter: string;
    pairs: [string, string, boolean][];
  };
}

Deno.test({
  name:
    "stampWorkerNonceBody: opted in, streamed through the runtime's HTMLRewriter, byte-identical",
  // The rewriter is denext's Deno's (runtime 3.0.0-denext.3+), behind a flag: stamped in a child.
  ignore: !(Deno.build as { denext?: string }).denext,
  async fn() {
    const shells = await stampCorpus();
    const { rewriter, pairs } = await stampInChild(shells, "1");
    assertEquals(rewriter, "function");
    assertEquals(pairs.length, shells.length);
    for (const [i, [string, streamed, viaRewriter]] of pairs.entries()) {
      assertEquals(streamed, string, `shell ${i}`);
      // The two hand-written shells without exactly one head take the string path.
      assertEquals(viaRewriter, i < shells.length - 2, `shell ${i} streamed`);
    }
    // The flag alone (no opt-in) keeps the string path: the rewriter is slower today.
    const plain = await stampInChild(shells, "");
    assertEquals(plain.rewriter, "function");
    assertEquals(plain.pairs.map(([, , via]) => via), shells.map(() => false));
  },
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
    assertStringIncludes(first, `src="/_denext/client/index.js" nonce="${a}"></script>`);
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
