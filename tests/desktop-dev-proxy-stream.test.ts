// `denext desktop dev`'s live-reload proxy injects the desktop global into the dev server's page as
// the page streams (src/build/desktop.ts, src/server/html-stream-rewriter.ts): the window gets the
// shell's first bytes when the dev server sends them and each streamed Suspense hole after,
// instead of the whole document once it ends; and the global lands after the real `<head>`, never
// inside a comment, a script or a style, wherever the chunks split.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createDesktopHandler } from "../src/build/desktop.ts";

const encoder = new TextEncoder();
const TOKEN = "tok-stream-xyz";

async function exportDir(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "index.html"), "<!doctype html><div id=root></div>");
  return dir;
}

/** A dev server page whose body is fed by the test. */
function feedablePage(headers: Record<string, string> = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return {
    response: new Response(body, { headers: { "content-type": "text/html", ...headers } }),
    send: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

async function proxied(dir: string, response: Response): Promise<Response> {
  const handle = createDesktopHandler({}, dir, undefined, TOKEN, undefined, () => response, true);
  return await handle(
    new Request("http://127.0.0.1:8000/", { headers: { accept: "text/html" } }),
    new URL("http://127.0.0.1:8000/"),
  );
}

/** `p`, or a rejection after `ms` (a buffering proxy would never resolve it). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms);
    }),
  ]);
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let text = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    text += new TextDecoder().decode(r.value);
  }
  return text;
}

Deno.test("desktop dev proxy: the shell's first bytes reach the window before the document ends (TTFB)", async () => {
  const dir = await exportDir();
  try {
    const HOLE_DELAY_MS = 1000;
    const page = feedablePage();
    page.send("<!DOCTYPE html><html><head><title>dev</title></head><body><div>shell</div>");
    const holeTimer = setTimeout(() => {
      page.send('<template data-dnx-r="b0"><p>hole</p></template></body></html>');
      page.close();
    }, HOLE_DELAY_MS);
    const started = performance.now();
    const res = await proxied(dir, page.response);
    const reader = res.body!.getReader();
    const first = await reader.read();
    const ttfb = performance.now() - started;
    clearTimeout(holeTimer);
    const text = new TextDecoder().decode(first.value);
    assertStringIncludes(text, "<div>shell</div>");
    assertStringIncludes(text, TOKEN, "the desktop global rides the first bytes");
    console.log(`desktop dev proxy TTFB: ${ttfb.toFixed(1)} ms (hole sent at ${HOLE_DELAY_MS} ms)`);
    assert(ttfb < HOLE_DELAY_MS / 2, `first byte after ${ttfb.toFixed(1)} ms`);
    page.send("</body></html>");
    page.close();
    await readAll(reader);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop dev proxy: a streamed Suspense hole still streams (the shell is read before the hole is sent)", async () => {
  const dir = await exportDir();
  try {
    const page = feedablePage();
    page.send("<!DOCTYPE html><html><head></head><body><div>fallback</div>");
    // The hole is sent only once the shell has been read: a proxy that holds the body never
    // yields the response or the shell, and the test fails instead of hanging.
    const res = await within(proxied(dir, page.response), 2000, "the response");
    const reader = res.body!.getReader();
    const shell = await within(reader.read(), 2000, "the shell");
    assertStringIncludes(new TextDecoder().decode(shell.value), "<div>fallback</div>");
    page.send('<template data-dnx-r="b0"><p>resolved</p></template>');
    const hole = await within(reader.read(), 2000, "the hole");
    assertEquals(
      new TextDecoder().decode(hole.value),
      '<template data-dnx-r="b0"><p>resolved</p></template>',
    );
    page.send("</body></html>");
    page.close();
    assertEquals(await readAll(reader), "</body></html>");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop dev proxy: the global lands after the real <head> when the tag is split across chunks, never in a comment or script", async () => {
  const dir = await exportDir();
  try {
    const policy = "default-src 'self'; script-src 'self'";
    const page = feedablePage();
    page.send(`<!DOCTYPE html><html><!-- <head> --><he`);
    page.send(`ad lang="en"><script>var s = "<head>";</script><meta http-equiv="Content-Secu`);
    page.send(`rity-Policy" content="${policy}"></head><body>x</body></html>`);
    page.close();
    const html = await (await proxied(dir, page.response)).text();
    assertStringIncludes(html, "<!-- <head> -->", "the comment is untouched");
    assertStringIncludes(html, `<script>var s = "<head>";</script>`, "the script is untouched");
    const at = html.indexOf('<head lang="en">') + '<head lang="en">'.length;
    assert(html.startsWith("<script>globalThis.__denext=", at), html);
    assertStringIncludes(html.slice(at), TOKEN);
    // The meta's policy now lists the injected script's hash.
    const script = /<script>(globalThis\.__denext=[\s\S]*?)<\/script>/.exec(html)![1];
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(script));
    const hash = `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
    assertStringIncludes(html, `content="${policy} ${hash}"`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
