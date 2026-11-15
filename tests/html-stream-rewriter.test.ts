// The first-party streaming HTML rewriter (src/server/html-stream-rewriter.ts): tags found across
// chunk boundaries, never inside comments or raw-text elements, and each chunk's output flushed
// with it.

import { assert, assertEquals } from "@std/assert";
import {
  type HtmlStreamHandlers,
  rewriteHtml,
  rewriteHtmlStream,
} from "../src/server/html-stream-rewriter.ts";

const encoder = new TextEncoder();

/** A stream of `chunks`, each its own read. */
function chunked(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) {
        c.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      c.close();
    },
  });
}

/**
 * Every split of `doc`'s bytes into two chunks (and one byte per chunk), rewritten, must equal the
 * one-pass result: a network splits bytes, multi-byte characters included.
 */
async function assertSplitInvariant(doc: string, handlers: () => HtmlStreamHandlers) {
  const whole = rewriteHtml(doc, handlers());
  const bytes = encoder.encode(doc);
  for (let at = 0; at <= bytes.length; at++) {
    const out = await new Response(
      rewriteHtmlStream(chunked([bytes.slice(0, at), bytes.slice(at)]), handlers()),
    ).text();
    assertEquals(out, whole, `split at byte ${at}`);
  }
  const bytewise = chunked([...bytes].map((b) => new Uint8Array([b])));
  assertEquals(await new Response(rewriteHtmlStream(bytewise, handlers())).text(), whole);
  return whole;
}

const afterHead = (): HtmlStreamHandlers => ({
  startTag(tag) {
    if (tag.name === "head") tag.after("<!--X-->");
  },
});

Deno.test("html stream rewriter: an injection lands right when the target tag is split across chunks", async () => {
  const doc = `<!DOCTYPE html><html><HEAD data-a="x>y" data-b='z'><title>t</title></HEAD>` +
    `<body><p>hi</p></body></html>`;
  const out = await assertSplitInvariant(doc, afterHead);
  assertEquals(
    out,
    `<!DOCTYPE html><html><HEAD data-a="x>y" data-b='z'><!--X--><title>t</title></HEAD>` +
      `<body><p>hi</p></body></html>`,
  );
});

Deno.test("html stream rewriter: no handler runs inside comments, scripts, styles or other raw text", async () => {
  const doc =
    `<!-- <head> - -- <body> --!><!-- <b> --><!--><!---><script>if (a<b) "</head><body>"; ` +
    `// </scrip t></script><style>/* <body> */ a>b{}</style><textarea><body></textarea>` +
    `<title><body></title><noscript><body></noscript><!DOCTYPE x><?pi <body>?></ <body>` +
    `<head></head><body></body>`;
  const seen: string[] = [];
  const handlers = (): HtmlStreamHandlers => {
    seen.length = 0;
    return {
      startTag(tag) {
        seen.push(tag.name);
        if (tag.name === "head" || tag.name === "body") tag.after("<!--X-->");
      },
      endTag(tag) {
        seen.push("/" + tag.name);
      },
    };
  };
  const out = await assertSplitInvariant(doc, handlers);
  assertEquals(seen, [
    "script",
    "/script",
    "style",
    "/style",
    "textarea",
    "/textarea",
    "title",
    "/title",
    "noscript",
    "/noscript",
    "head",
    "/head",
    "body",
    "/body",
  ]);
  assertEquals(out.split("<!--X-->").length, 3, "one injection after each real tag");
  assert(out.endsWith("<head><!--X--></head><body><!--X--></body>"));
});

Deno.test("html stream rewriter: the first bytes go out before the document ends", async () => {
  let send!: (text: string | null) => void;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      send = (t) => t === null ? c.close() : c.enqueue(encoder.encode(t));
    },
  });
  const reader = rewriteHtmlStream(source, afterHead()).getReader();
  send("<html><head><title>t</title></head><body><div>shell</div>");
  const first = await reader.read();
  assertEquals(
    new TextDecoder().decode(first.value),
    "<html><head><!--X--><title>t</title></head><body><div>shell</div>",
  );
  // An unfinished tag waits for its end, and only it.
  send("<p>hole</p><templ");
  assertEquals(new TextDecoder().decode((await reader.read()).value), "<p>hole</p>");
  send('ate data-dnx-r="b0"></template>');
  send(null);
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    rest += new TextDecoder().decode(r.value);
  }
  assertEquals(rest, '<template data-dnx-r="b0"></template>');
});

Deno.test("html stream rewriter: setAttribute rewrites the tag as HTMLRewriter writes it", () => {
  const out = rewriteHtml(
    `<meta http-equiv="Content-Security-Policy" content="script-src 'self'"><script src=a.js></script><br/>`,
    {
      startTag(tag) {
        if (tag.name === "meta") {
          assertEquals(tag.getAttribute("HTTP-EQUIV"), "Content-Security-Policy");
          tag.setAttribute("content", `${tag.getAttribute("content")} 'sha256-"x"'`);
        }
        if (tag.name === "script") tag.setAttribute("nonce", "n");
        if (tag.name === "br") assert(tag.selfClosing);
      },
    },
  );
  assertEquals(
    out,
    `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-&quot;x&quot;'">` +
      `<script src=a.js nonce="n"></script><br/>`,
  );
});

Deno.test("html stream rewriter: a surrogate pair split by the carry survives; end() appends; stop() passes the rest through", async () => {
  const emoji = "<!--" + "\u{1F600}".repeat(3) + "--><script>\u{1F600}</script><b>";
  assertEquals(await assertSplitInvariant(emoji, () => ({})), emoji);
  assertEquals(rewriteHtml("text", { end: () => "<!--end-->" }), "text<!--end-->");
  const seen: string[] = [];
  const out = rewriteHtml("<a><b><c>", {
    startTag(tag, control) {
      seen.push(tag.name);
      if (tag.name === "b") control.stop();
    },
  });
  assertEquals(out, "<a><b><c>");
  assertEquals(seen, ["a", "b"]);
  // An unfinished construct at the end of the document is written as it is.
  assertEquals(rewriteHtml("<p>x</p><div class=", {}), "<p>x</p><div class=");
});
