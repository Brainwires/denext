// The fumadocs-mdx compile host. `fumadocs-mdx` ships a Node ESM loader hook
// (`fumadocs-mdx/node/_loader`: `initialize` + `load`) that turns `x.mdx?collection=docs` and
// `meta.json?collection=docs` into JS modules using the app's own `source.config.ts`. That
// loader lives in the app's node_modules and imports its deps bare (`zod`, `fumadocs-core`,
// `@mdx-js/mdx`), which only resolve under Deno's byonm mode — and the denext CLI process
// runs with `--node-modules-dir=none` so ITS npm deps never resolve from the app tree. So the
// compat bundler hosts the loader here, in a child that runs `--node-modules-dir=manual` with
// the app dir as cwd (fumadocs reads `source.config.ts` relative to `process.cwd()`).
//
// Protocol: newline-delimited JSON over stdio. Request `{ id, url }` (a `file://` URL with the
// fumadocs query) → response `{ id, source }` or `{ id, error }`. Requests are served
// concurrently; the child exits when stdin closes. This module deliberately imports NOTHING
// (no `@std/*`) so it runs unchanged as a file:// or a JSR https:// entrypoint without a config.
//
// argv: <appDir> <loaderModuleUrl> <configPath>

const [appDir, loaderUrl, configPath] = Deno.args;
if (!appDir || !loaderUrl) {
  console.error("usage: fumadocs-mdx-worker <appDir> <loaderModuleUrl> [configPath]");
  Deno.exit(2);
}
Deno.chdir(appDir);

interface LoaderModule {
  initialize(options: { configPath?: string }): void;
  load(
    url: string,
    context: Record<string, unknown>,
    nextLoad: (url: string) => never,
  ): Promise<{ source: string | Uint8Array }>;
}

const loader = await import(loaderUrl) as LoaderModule;
loader.initialize({ configPath: configPath || "source.config.ts" });

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const writer = Deno.stdout.writable.getWriter();
let writeChain: Promise<void> = Promise.resolve();
function reply(msg: Record<string, unknown>): void {
  writeChain = writeChain.then(() => writer.write(encoder.encode(JSON.stringify(msg) + "\n")));
}

async function handle(line: string): Promise<void> {
  let id: unknown = null;
  try {
    const req = JSON.parse(line) as { id: unknown; url: string };
    id = req.id;
    const out = await loader.load(req.url, {}, (url) => {
      throw new Error(`fumadocs-mdx did not claim ${url}`);
    });
    const source = typeof out.source === "string" ? out.source : decoder.decode(out.source);
    reply({ id, source });
  } catch (e) {
    reply({ id, error: e instanceof Error ? e.message : String(e) });
  }
}

let buf = "";
for await (const chunk of Deno.stdin.readable) {
  buf += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) void handle(line);
  }
}
await writeChain;
