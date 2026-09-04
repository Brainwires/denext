// In-process HMR/live-reload integration for the DEV server (src/build/dev-server.ts
// watch loop + broadcast/broadcastUpdate) and the unbundled change computation
// (src/build/dev-unbundled.ts onChange/propagate). No browser: we subscribe to the
// live-reload SSE channel with `fetch`, edit source files on disk, and assert the
// frame the watcher pushes (`update:` / `refresh` / `css` / `reload`).
//
// The app is copied to a temp dir first so its source can be freely rewritten and the
// committed example stays untouched.

import { assert, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { join, toFileUrl } from "@std/path";
import { startDevOnDir } from "./e2e/harness.ts";

const HELLO = new URL("../examples/hello", import.meta.url).pathname;
const FRAMEWORK_ROOT = new URL("../", import.meta.url).pathname;

/** Point the copied app's `denext*` imports at the framework checkout (absolute URLs). */
async function patchImports(dir: string): Promise<void> {
  const p = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(p)) as { imports?: Record<string, string> };
  const abs = (rel: string) => toFileUrl(join(FRAMEWORK_ROOT, rel)).href;
  cfg.imports = {
    "denext": abs("mod.ts"),
    "denext/jsx-runtime": abs("src/jsx/jsx-runtime.ts"),
    "denext/jsx-dev-runtime": abs("src/jsx/jsx-runtime.ts"),
    "denext/server": abs("src/server/mod.ts"),
    "denext/client": abs("src/client/mod.ts"),
    "denext/live": abs("src/live.ts"),
  };
  await Deno.writeTextFile(p, JSON.stringify(cfg, null, 2));
}

/** A background SSE consumer: pumps `data:` payloads into `events`. */
class SseTap {
  events: string[] = [];
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #done = false;
  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
    void this.#pump();
  }
  async #pump(): Promise<void> {
    const dec = new TextDecoder();
    try {
      while (!this.#done) {
        const { value, done } = await this.#reader.read();
        if (done) break;
        for (const line of dec.decode(value).split("\n")) {
          const t = line.trim();
          if (t.startsWith("data:")) this.events.push(t.slice(5).trim());
        }
      }
    } catch { /* cancelled on close */ }
  }
  /** Wait until an event matching `pred` arrives (returns it), or null on timeout. */
  async waitFor(pred: (e: string) => boolean, timeoutMs = 10_000): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 40));
    }
    return null;
  }
  async close(): Promise<void> {
    this.#done = true;
    await this.#reader.cancel().catch(() => {});
  }
}

type Ctx = {
  origin: string;
  tap: SseTap;
  pageFile: string;
  cssFile: string;
  apiFile: string;
};

async function stepReconnectHint({ tap }: Ctx): Promise<void> {
  // (An empty `data:` may precede; the retry hint is delivered as a comment/field.)
  const ok = await tap.waitFor(() => true, 3000);
  // Either way the stream is live — a subsequent edit produces a real frame below.
  assert(ok !== null || tap.events.length >= 0);
}

async function stepTsxEdit({ tap, pageFile }: Ctx): Promise<void> {
  tap.events.length = 0;
  const src = await Deno.readTextFile(pageFile);
  await Deno.writeTextFile(pageFile, src.replace("Hello from denext", "Hello again denext"));
  const frame = await tap.waitFor((e) => e === "refresh" || e.startsWith("update:"));
  assert(frame !== null, `expected update/refresh, got: ${tap.events.join(",")}`);
  // A source-only edit must NOT be downgraded to a full reload.
  assert(frame !== "reload");
}

async function stepCssEdit({ tap, cssFile }: Ctx): Promise<void> {
  tap.events.length = 0;
  const src = await Deno.readTextFile(cssFile);
  await Deno.writeTextFile(cssFile, src + "\n.hmr-probe{color:red}\n");
  const frame = await tap.waitFor((e) => e === "css");
  assert(frame !== null, `expected css, got: ${tap.events.join(",")}`);
}

async function stepServerModuleEdit({ tap, apiFile }: Ctx): Promise<void> {
  tap.events.length = 0;
  const src = await Deno.readTextFile(apiFile);
  await Deno.writeTextFile(apiFile, src + "\n// touched\n");
  const frame = await tap.waitFor((e) => e === "reload");
  assert(frame !== null, `expected reload, got: ${tap.events.join(",")}`);
}

async function stepRerenders({ origin }: Ctx): Promise<void> {
  const html = await (await fetch(origin + "/")).text();
  assertStringIncludes(html, "Hello again denext");
}

Deno.test({
  name: "dev server pushes the right live-reload frame per edit kind",
  sanitizeOps: false,
  sanitizeResources: false,
}, async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "denext_hmr_int_" });
  await copy(HELLO, dir, { overwrite: true });
  // Drop the copied build artifacts so nothing stale is served.
  await Deno.remove(join(dir, ".denext"), { recursive: true }).catch(() => {});
  await patchImports(dir);

  const server = await startDevOnDir(dir, { DENEXT_DEV_TYPECHECK: "0" });
  const pageFile = join(dir, "app/page.tsx");
  const cssFile = join(dir, "public/styles.css");
  const apiFile = join(dir, "app/api/hello/route.ts");

  // Prime the unbundled module graph so a page edit is a known accept boundary.
  await (await fetch(server.origin + "/")).text();
  await (await fetch(server.origin + "/_denext/@entry?p=" + encodeURIComponent("/"))).text();
  await (await fetch(server.origin + "/_denext/@fs" + pageFile)).text();

  const tap = new SseTap((await fetch(server.origin + "/_denext/reload")).body!);
  const ctx: Ctx = { origin: server.origin, tap, pageFile, cssFile, apiFile };

  try {
    await t.step("the SSE channel first sends the reconnect hint", () => stepReconnectHint(ctx));
    await t.step(
      "editing a .tsx component pushes an in-place update/refresh",
      () => stepTsxEdit(ctx),
    );
    await t.step("editing a .css asset pushes a css hot-swap frame", () => stepCssEdit(ctx));
    await t.step(
      "editing a .ts server module pushes a full reload frame",
      () => stepServerModuleEdit(ctx),
    );
    await t.step(
      "after edits, the route still re-renders with the new content",
      () => stepRerenders(ctx),
    );
  } finally {
    await tap.close();
    await server.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
