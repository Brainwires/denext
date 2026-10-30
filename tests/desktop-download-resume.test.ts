// The Deno Desktop `fs` capability's download pause / resume against a REAL local HTTP server:
// the partial file (`<dest>.part`) and its sidecar (`<dest>.part.json`), `Range` + `If-Range`
// (never a weak ETag), the 206 / 200 / 416 answers, a connection cut mid-body, a resume after a
// "restart" (a new capability instance), the scope and SSRF checks re-run on a resume, and the byte
// cap counted over the whole file.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { fsCapability, type FsCapabilityConfig } from "../src/desktop/caps/fs.ts";
import { openPartial, partialAt, writeSidecar } from "../src/desktop/caps/download-partial.ts";
import {
  SETTLED_RETENTION_MS,
  TRANSFER_RECORDS_DIR,
} from "../src/desktop/caps/transfer-records.ts";
import { type DesktopCapCtx, DesktopCapError } from "../src/desktop/extension.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import {
  cancelFileTransfer,
  type FileTransferEvent,
  fileTransfers,
  forgetFileTransfer,
  onFileTransfer,
  resumeFileTransfer,
} from "../src/mobile/mod.ts";
import { resetFileTransfersForTesting } from "../src/mobile/file-transfer.ts";
import {
  createFakeDesktopRuntime,
  type FakeMethod,
  until,
} from "./helpers/desktop-fake-runtime.ts";

const OS = Deno.build.os as "darwin" | "windows" | "linux";

/** The file the server serves (1000 bytes), and another version of it. */
const BODY = new Uint8Array(1000).map((_, i) => i % 251);
const BODY_V2 = BODY.slice().reverse();
const URL_A = "https://files.test/a.bin";

/** How the server answers (mutable between requests). */
interface ServerMode {
  body: Uint8Array;
  etag?: string;
  lastModified?: string;
  /** Answer a matching `Range` + `If-Range` with a 206 (else a 200 with the whole file). */
  honorRange: boolean;
  /** The next plain request sends this many bytes, then the connection is cut (once). */
  cutOnce?: number;
  /** The next plain request sends this many bytes, then holds until the client goes away (once). */
  holdOnce?: number;
  /** No `Content-Length` (a chunked body), on 200s and 206s alike. */
  noLength?: boolean;
  /** A 206's `Content-Range` total is `*` (unknown). */
  starTotal?: boolean;
}

/** The validator headers `mode` sends. */
function validatorHeaders(mode: ServerMode): Headers {
  const headers = new Headers();
  if (mode.etag) headers.set("etag", mode.etag);
  if (mode.lastModified) headers.set("last-modified", mode.lastModified);
  return headers;
}

/** Where a `Range` + `If-Range` request the server honors starts, or `undefined`. */
function honoredFrom(mode: ServerMode, req: Request): number | undefined {
  if (!mode.honorRange) return undefined;
  const from = Number(/^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "")?.[1] ?? NaN);
  const ifRange = req.headers.get("if-range");
  const matches = ifRange !== null && ifRange === (mode.etag ?? mode.lastModified);
  return Number.isFinite(from) && matches ? from : undefined;
}

/** The 206 (or, past the end, 416) for a range from `from`. */
function rangeAnswer(mode: ServerMode, from: number): Response {
  const { body } = mode;
  const headers = validatorHeaders(mode);
  if (from >= body.byteLength) {
    headers.set("content-range", `bytes */${body.byteLength}`);
    return new Response(null, { status: 416, headers });
  }
  const total = mode.starTotal ? "*" : String(body.byteLength);
  headers.set("content-range", `bytes ${from}-${body.byteLength - 1}/${total}`);
  if (!mode.noLength) headers.set("content-length", String(body.byteLength - from));
  return new Response(body.slice(from), { status: 206, headers });
}

/** The whole file as a 200: cut or held after the first bytes once when `mode` says so. */
function fullAnswer(mode: ServerMode): Response {
  const { body } = mode;
  const headers = validatorHeaders(mode);
  if (!mode.noLength) headers.set("content-length", String(body.byteLength));
  const cut = mode.cutOnce;
  const first = cut ?? mode.holdOnce;
  mode.cutOnce = undefined;
  mode.holdOnce = undefined;
  if (first === undefined) return new Response(body.slice(), { headers });
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(body.slice(0, first));
      if (cut !== undefined) setTimeout(() => c.error(new Error("connection cut")), 50);
    },
  });
  return new Response(stream, { headers });
}

/**
 * A local server for `https://files.test/*`, with each request's `range` / `if-range` seen (and
 * its `authorization`).
 */
function startServer(mode: ServerMode) {
  const seen: Array<[string | null, string | null]> = [];
  const auths: Array<string | null> = [];
  const controller = new AbortController();
  const listening = Promise.withResolvers<number>();
  const server = Deno.serve({
    port: 0,
    hostname: "127.0.0.1",
    signal: controller.signal,
    onListen: ({ port }) => listening.resolve(port),
    onError: () => new Response(null, { status: 500 }),
  }, (req) => {
    seen.push([req.headers.get("range"), req.headers.get("if-range")]);
    auths.push(req.headers.get("authorization"));
    const from = honoredFrom(mode, req);
    return from === undefined ? fullAnswer(mode) : rangeAnswer(mode, from);
  });
  return {
    seen,
    auths,
    port: listening.promise,
    async close() {
      controller.abort();
      await server.finished;
    },
  };
}

/** The process's own `fetch`. */
const realFetch = globalThis.fetch;

/** A `ctx` for a capability call. */
function ctx(overrides: Partial<DesktopCapCtx> = {}): DesktopCapCtx {
  return {
    emit: () => {},
    appSupportDir: "",
    runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
    os: OS,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Call a capability method's handler by name, via a promise (as the bridge dispatches). */
// deno-lint-ignore no-explicit-any
function call(cap: { methods: Record<string, any> }, method: string, args: unknown) {
  return Promise.resolve().then(() => cap.methods[method].handler(args, ctx()));
}

/** A capability error's code. */
async function rejectCode(p: Promise<unknown>): Promise<string> {
  return (await assertRejects(() => p, DesktopCapError)).code;
}

/**
 * Run `fn` with a server in `mode` and a factory of `fs` capabilities over one temp dir (each a
 * fresh instance, as after a restart) whose `https://files.test` requests go to the server.
 */
async function withServer(
  mode: ServerMode,
  fn: (t: {
    root: string;
    seen: Array<[string | null, string | null]>;
    auths: Array<string | null>;
    cap: (over?: Partial<FsCapabilityConfig>) => ReturnType<typeof fsCapability>;
  }) => Promise<void>,
): Promise<void> {
  const server = startServer(mode);
  const port = await server.port;
  const root = await Deno.makeTempDir({ prefix: "denext-dl-resume-" });
  // The app dirs exist (as the runtime makes them); the scope check compares real paths.
  await Deno.mkdir(join(root, "data"));
  const cap = (over: Partial<FsCapabilityConfig> = {}) =>
    fsCapability({
      dirs: { data: join(root, "data"), cache: join(root, "cache"), documents: join(root, "docs") },
      read: new Set(["$APPDATA"]),
      write: new Set(["$APPDATA"]),
      downloadTimeoutMs: 10_000,
      resolveHost: () => Promise.resolve(["93.184.216.34"]),
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        realFetch(
          String(input).replace("https://files.test", `http://127.0.0.1:${port}`),
          init,
        )) as typeof fetch,
      ...over,
    });
  try {
    await fn({ root, seen: server.seen, auths: server.auths, cap });
  } finally {
    await server.close();
    await Deno.remove(root, { recursive: true });
  }
}

/** The files under the data dir (sorted), as the page lists them: the download records' folder left out. */
async function dataFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(join(root, "data"))) {
    if (e.name !== TRANSFER_RECORDS_DIR) out.push(e.name);
  }
  return out.sort();
}

/** A download of `url` to `data/<path>` (with id `id`, if any) through `method`. */
function dl(
  cap: ReturnType<typeof fsCapability>,
  url: string,
  path: string,
  extra: Record<string, unknown> = {},
  method = "download",
) {
  return call(cap, method, { url, path, directory: "data", ...extra }) as Promise<
    { path: string; bytes: number }
  >;
}

/** Cut a first download of `url` to `data/<path>` mid-body; resolves the bytes it kept. */
async function cutDownload(
  cap: ReturnType<typeof fsCapability>,
  url: string,
  path: string,
): Promise<number> {
  const err = await assertRejects(() => dl(cap, url, path), DesktopCapError);
  assertEquals(err.code, "network");
  const { bytes } = err.data as { bytes: number };
  assert(bytes > 0 && bytes < BODY.byteLength, `kept ${bytes}`);
  return bytes;
}

Deno.test({
  name: "resume: a cut connection keeps .part + sidecar; a resume sends Range/If-Range (206)",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: true, cutOnce: 400 }, async (t) => {
    const cap = t.cap();
    const err = await assertRejects(() => dl(cap, URL_A, "a.bin"), DesktopCapError);
    assertEquals(err.code, "network");
    const data = err.data as { bytes: number; total: number; resumable: boolean };
    assertEquals([data.total, data.resumable], [1000, true]);
    const kept = data.bytes;
    assertEquals(await dataFiles(t.root), ["a.bin.part", "a.bin.part.json"]);
    assertEquals((await Deno.stat(join(t.root, "data", "a.bin.part"))).size, kept);
    const sidecar = JSON.parse(await Deno.readTextFile(join(t.root, "data", "a.bin.part.json")));
    assertEquals(sidecar, { v: 1, url: URL_A, validator: '"v1"', total: 1000, bytes: kept });

    const out = await dl(cap, URL_A, "a.bin", {}, "resumeDownload");
    assertEquals(out.bytes, 1000);
    assertEquals(await Deno.readFile(join(t.root, "data", "a.bin")), BODY);
    assertEquals(t.seen, [[null, null], [`bytes=${kept}-`, '"v1"']]);
    assertEquals(await dataFiles(t.root), ["a.bin"], "the partial and its sidecar are gone");
  });
});

Deno.test({
  name: "resume: a server that ignores Range (200) starts it over: truncated, not appended",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: false, cutOnce: 400 }, async (t) => {
    const cap = t.cap();
    const kept = await cutDownload(cap, URL_A, "a.bin");
    const out = await dl(cap, URL_A, "a.bin", {}, "resumeDownload");
    assertEquals(out.bytes, 1000);
    assertEquals(await Deno.readFile(join(t.root, "data", "a.bin")), BODY);
    assertEquals(t.seen[1], [`bytes=${kept}-`, '"v1"']);
    assertEquals(await dataFiles(t.root), ["a.bin"]);
  });
});

Deno.test({
  name: "resume: a changed validator (If-Range no longer matches) restarts with the new file",
}, async () => {
  const mode: ServerMode = { body: BODY, etag: '"v1"', honorRange: true, cutOnce: 400 };
  await withServer(mode, async (t) => {
    const cap = t.cap();
    await cutDownload(cap, URL_A, "a.bin");
    mode.body = BODY_V2;
    mode.etag = '"v2"';
    const out = await dl(cap, URL_A, "a.bin", {}, "resumeDownload");
    assertEquals(out.bytes, 1000);
    assertEquals(await Deno.readFile(join(t.root, "data", "a.bin")), BODY_V2);
    assertEquals(t.seen[1][1], '"v1"');
  });
});

Deno.test({
  name: "resume: a 416 for a partial that is already the whole file finishes it; else it restarts",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: true }, async (t) => {
    const cap = t.cap();
    const dir = join(t.root, "data");
    await Deno.mkdir(dir, { recursive: true });
    const sidecar = (total: number, bytes: number) =>
      JSON.stringify({ v: 1, url: URL_A, validator: '"v1"', total, bytes });
    await Deno.writeFile(join(dir, "done.bin.part"), BODY);
    await Deno.writeTextFile(join(dir, "done.bin.part.json"), sidecar(1000, 1000));
    const out = await dl(cap, URL_A, "done.bin", {}, "resumeDownload");
    assertEquals(out.bytes, 1000);
    assertEquals(await Deno.readFile(join(dir, "done.bin")), BODY);
    assertEquals(t.seen, [["bytes=1000-", '"v1"']]);
    assertEquals(await dataFiles(t.root), ["done.bin"]);

    // A 416 where the kept bytes are not the known size: the partial is wrong, start over.
    await Deno.writeFile(join(dir, "odd.bin.part"), new Uint8Array(1200));
    await Deno.writeTextFile(join(dir, "odd.bin.part.json"), sidecar(2000, 1200));
    assertEquals((await dl(cap, URL_A, "odd.bin", {}, "resumeDownload")).bytes, 1000);
    assertEquals(await Deno.readFile(join(dir, "odd.bin")), BODY);
    assertEquals(t.seen.slice(1), [["bytes=1200-", '"v1"'], [null, null]]);
  });
});

Deno.test({
  name: "resume: a 206 whose Content-Range does not continue the kept bytes restarts from zero",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: true }, async (t) => {
    const dir = join(t.root, "data");
    await Deno.mkdir(dir, { recursive: true });
    // 500 bytes kept; the server (a fetch shim) answers the range from byte 100 instead.
    await Deno.writeFile(join(dir, "m.bin.part"), BODY.slice(0, 500));
    await Deno.writeTextFile(
      join(dir, "m.bin.part.json"),
      JSON.stringify({ v: 1, url: URL_A, validator: '"v1"', total: 1000, bytes: 500 }),
    );
    const cap = t.cap({
      fetch: ((_input: string | URL | Request, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("range");
        if (range) {
          return Promise.resolve(
            new Response(BODY.slice(100), {
              status: 206,
              headers: { "content-range": "bytes 100-999/1000", etag: '"v1"' },
            }),
          );
        }
        return Promise.resolve(new Response(BODY.slice(), { headers: { etag: '"v1"' } }));
      }) as typeof fetch,
    });
    assertEquals((await dl(cap, URL_A, "m.bin", {}, "resumeDownload")).bytes, 1000);
    assertEquals(await Deno.readFile(join(dir, "m.bin")), BODY);
  });
});

Deno.test({
  name: "resume: a weak-ETag-only server is never sent If-Range: the resume starts over",
}, async () => {
  await withServer({ body: BODY, etag: 'W/"w1"', honorRange: true, cutOnce: 400 }, async (t) => {
    const cap = t.cap();
    const err = await assertRejects(() => dl(cap, URL_A, "w.bin"), DesktopCapError);
    assertEquals((err.data as { resumable: boolean }).resumable, false);
    const sidecar = JSON.parse(await Deno.readTextFile(join(t.root, "data", "w.bin.part.json")));
    assertEquals(sidecar.validator, null);
    assertEquals((await dl(cap, URL_A, "w.bin", {}, "resumeDownload")).bytes, 1000);
    assertEquals(await Deno.readFile(join(t.root, "data", "w.bin")), BODY);
    assertEquals(t.seen, [[null, null], [null, null]], "no Range, no weak If-Range");
  });
});

Deno.test({
  name: "resume: Last-Modified is the validator when the ETag is weak",
}, async () => {
  const lastModified = "Wed, 21 Oct 2026 07:28:00 GMT";
  await withServer(
    { body: BODY, etag: 'W/"w1"', lastModified, honorRange: false, cutOnce: 400 },
    async (t) => {
      const cap = t.cap();
      const kept = await cutDownload(cap, URL_A, "lm.bin");
      await dl(cap, URL_A, "lm.bin", {}, "resumeDownload");
      assertEquals(t.seen[1], [`bytes=${kept}-`, lastModified]);
      assertEquals(await Deno.readFile(join(t.root, "data", "lm.bin")), BODY);
    },
  );
});

Deno.test({
  name: "resume: after a restart (a new capability instance) the sidecar continues the download",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: true, cutOnce: 400 }, async (t) => {
    const kept = await cutDownload(t.cap(), URL_A, "r.bin");
    // A new instance has no memory of the first: only the files on disk carry over.
    const out = await dl(t.cap(), URL_A, "r.bin", { id: "after-restart" }, "resumeDownload");
    assertEquals(out.bytes, 1000);
    assertEquals(await Deno.readFile(join(t.root, "data", "r.bin")), BODY);
    assertEquals(t.seen[1], [`bytes=${kept}-`, '"v1"']);
  });
});

Deno.test({
  name: "resume SECURITY: the destination must be in a granted dir; another URL's partial restarts",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: true, cutOnce: 400 }, async (t) => {
    const cap = t.cap();
    await cutDownload(cap, URL_A, "s.bin");
    // Outside the granted dir, or a directory not in the write scope: refused before any request.
    assertEquals(
      await rejectCode(dl(cap, URL_A, "../escape.bin", {}, "resumeDownload")),
      "forbidden",
    );
    assertEquals(
      await rejectCode(
        call(cap, "resumeDownload", { url: URL_A, path: "s.bin", directory: "documents" }),
      ),
      "forbidden",
    );
    assertEquals(t.seen.length, 1);
    // A partial left for another URL is never continued into this request's file.
    const other = "https://files.test/other.bin";
    assertEquals((await dl(cap, other, "s.bin", {}, "resumeDownload")).bytes, 1000);
    assertEquals(t.seen[1], [null, null]);
    assertEquals(await dataFiles(t.root), ["s.bin"]);
  });
});

Deno.test({
  name: "resume SECURITY: a symlinked .part is dropped, never written through",
  ignore: OS === "windows",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: true }, async (t) => {
    const dir = join(t.root, "data");
    await Deno.mkdir(dir, { recursive: true });
    const victim = join(t.root, "victim.txt");
    await Deno.writeTextFile(victim, "keep me");
    await Deno.symlink(victim, join(dir, "l.bin.part"));
    await Deno.writeTextFile(
      join(dir, "l.bin.part.json"),
      JSON.stringify({ v: 1, url: URL_A, validator: '"v1"', total: 1000, bytes: 7 }),
    );
    assertEquals((await dl(t.cap(), URL_A, "l.bin", {}, "resumeDownload")).bytes, 1000);
    assertEquals(await Deno.readTextFile(victim), "keep me");
    assertEquals(await Deno.readFile(join(dir, "l.bin")), BODY);
    assertEquals(t.seen, [[null, null]]);
  });
});

Deno.test({
  name:
    "resume SECURITY: the host checks run again on a resume; a LAN resume sends only our headers",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: true, cutOnce: 400 }, async (t) => {
    await cutDownload(t.cap(), URL_A, "h.bin");
    // The name now resolves to loopback: the resume is refused like a first request would be.
    const rebound = t.cap({ resolveHost: () => Promise.resolve(["127.0.0.1"]) });
    assertEquals(await rejectCode(dl(rebound, URL_A, "h.bin", {}, "resumeDownload")), "forbidden");
    assertEquals(t.seen.length, 1);
    // On the LAN: the page's own header is still refused on the resume...
    const lan = t.cap({ resolveHost: () => Promise.resolve(["192.168.1.5"]) });
    assertEquals(
      await rejectCode(
        dl(lan, URL_A, "h.bin", { headers: { "x-api-key": "k" } }, "resumeDownload"),
      ),
      "forbidden",
    );
    // ...while the runtime's own Range / If-Range go through.
    assertEquals((await dl(lan, URL_A, "h.bin", {}, "resumeDownload")).bytes, 1000);
    assertEquals(t.seen.at(-1)?.[1], '"v1"');
    assertEquals(await Deno.readFile(join(t.root, "data", "h.bin")), BODY);
  });
});

Deno.test({
  name: "resume: downloadMaxBytes counts the whole file across segments, then drops the partial",
}, async () => {
  const mode: ServerMode = {
    body: BODY,
    etag: '"v1"',
    honorRange: true,
    cutOnce: 400,
    noLength: true,
    starTotal: true,
  };
  await withServer(mode, async (t) => {
    // 700 bytes: each segment (400, then 600) fits; the file (1000) does not.
    const cap = t.cap({ downloadMaxBytes: 700 });
    await cutDownload(cap, URL_A, "big.bin");
    assertEquals(await rejectCode(dl(cap, URL_A, "big.bin", {}, "resumeDownload")), "too_large");
    assertEquals(await dataFiles(t.root), [], "nothing kept past the cap");
    // A 206 that announces the full size refuses before reading any of it.
    mode.cutOnce = 400;
    mode.starTotal = false;
    await cutDownload(cap, URL_A, "big2.bin");
    assertEquals(await rejectCode(dl(cap, URL_A, "big2.bin", {}, "resumeDownload")), "too_large");
    assertEquals(await dataFiles(t.root), []);
  });
});

Deno.test({
  name: "pauseDownload keeps the partial; cancelDownload drops a paused one; one download per file",
}, async () => {
  const mode: ServerMode = { body: BODY, etag: '"v1"', honorRange: true, holdOnce: 300 };
  await withServer(mode, async (t) => {
    const cap = t.cap();
    const part = join(t.root, "data", "p.bin.part");
    const waitPart = async () => {
      const end = Date.now() + 5_000;
      while ((await Deno.stat(part).then((i) => i.size, () => 0)) < 300) {
        if (Date.now() > end) throw new Error("the first chunk never arrived");
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const running = dl(cap, URL_A, "p.bin", { id: "p" });
    running.catch(() => {});
    await waitPart();
    // A second download into the same file while the first runs is refused.
    assertEquals(await rejectCode(dl(cap, URL_A, "p.bin", { id: "q" })), "exists");
    assertEquals(await call(cap, "pauseDownload", { id: "p" }), { paused: true });
    const paused = await assertRejects(() => running, DesktopCapError);
    assertEquals(paused.code, "paused");
    assertEquals(paused.data, { bytes: 300, total: 1000, resumable: true });
    assertEquals(await dataFiles(t.root), ["p.bin.part", "p.bin.part.json"]);
    assertEquals(await call(cap, "pauseDownload", { id: "p" }), { paused: false });
    assertEquals(await call(cap, "pauseDownload", { id: "nope" }), { paused: false });

    // Resume under the same id: it continues from the 300 bytes kept.
    assertEquals((await dl(cap, URL_A, "p.bin", { id: "p" }, "resumeDownload")).bytes, 1000);
    assertEquals(t.seen.at(-1), ["bytes=300-", '"v1"']);
    assertEquals(await Deno.readFile(join(t.root, "data", "p.bin")), BODY);

    // Paused, then cancelled: the partial and its sidecar go.
    mode.holdOnce = 300;
    await Deno.remove(join(t.root, "data", "p.bin"));
    const again = dl(cap, URL_A, "p.bin", { id: "p2" });
    again.catch(() => {});
    await waitPart();
    assertEquals(await call(cap, "pauseDownload", { id: "p2" }), { paused: true });
    assertEquals(await rejectCode(again), "paused");
    assertEquals(await call(cap, "cancelDownload", { id: "p2" }), { cancelled: true });
    assertEquals(await dataFiles(t.root), []);
    assertEquals(await call(cap, "cancelDownload", { id: "p2" }), { cancelled: false });
  });
});

/** The names in `dir` (sorted; none when it doesn't exist). */
async function namesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) out.push(e.name);
  } catch { /* missing */ }
  return out.sort();
}

Deno.test({
  name: "resume: a picked single file keeps its partial in the cache dir, never beside the file",
}, async () => {
  await withServer({ body: BODY, etag: '"v1"', honorRange: true, cutOnce: 400 }, async (t) => {
    const outside = join(t.root, "picked");
    await Deno.mkdir(outside);
    const file = join(await Deno.realPath(outside), "pick.bin");
    await Deno.writeTextFile(file, "old");
    // Another program's in-progress download beside the picked file: not ours to touch.
    await Deno.writeTextFile(`${file}.part`, "someone else's bytes");
    const picked = new PickedPaths();
    const handle = picked.add(file, "readwrite");
    const cap = t.cap({ picked });
    const cut = await assertRejects(
      () => call(cap, "download", { url: URL_A, directory: { picked: handle } }),
      DesktopCapError,
    );
    assertEquals(cut.code, "network");
    const kept = (cut.data as { bytes: number }).bytes;
    assert(kept > 0 && kept < 1000, `kept ${kept}`);
    assertEquals(await namesIn(outside), ["pick.bin", "pick.bin.part"], "nothing new beside it");
    assertEquals(await Deno.readTextFile(`${file}.part`), "someone else's bytes");
    const cacheParts = await namesIn(join(t.root, "cache", "denext-downloads"));
    assertEquals(cacheParts.length, 2, JSON.stringify(cacheParts));
    assert(cacheParts.every((n) => /^[0-9a-f]{64}\.part(\.json)?$/.test(n)), cacheParts.join());

    // The resume continues from the cache-dir partial and moves it into place.
    const done = await call(cap, "resumeDownload", { url: URL_A, directory: { picked: handle } });
    assertEquals((done as { bytes: number }).bytes, 1000);
    assertEquals(t.seen.at(-1), [`bytes=${kept}-`, '"v1"']);
    assertEquals(await Deno.readFile(file), BODY);
    assertEquals(await namesIn(outside), ["pick.bin", "pick.bin.part"]);
    assertEquals(await Deno.readTextFile(`${file}.part`), "someone else's bytes");
    assertEquals(await namesIn(join(t.root, "cache", "denext-downloads")), []);
  });
});

Deno.test({
  name: "resume SECURITY: appending refuses a partial that was truncated or swapped for a link",
}, async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-dl-guard-" });
  try {
    const at = await partialAt(join(dir, "g.bin"));
    const first = await openPartial(at, false, 0);
    await first.write(new Uint8Array(7));
    first.close();
    await writeSidecar(at, { url: URL_A, validator: '"v1"', total: 1000, bytes: 7 });
    // Truncated under the request: nothing to append to.
    await Deno.truncate(`${at.base}.part`, 3);
    await assertRejects(() => openPartial(at, true, 7), Error, "the partial file changed");
    if (OS !== "windows") {
      // Swapped for a symlink of the same size: refused, and the link's target untouched.
      const victim = join(dir, "victim.txt");
      await Deno.writeTextFile(victim, "seven!!");
      await Deno.remove(`${at.base}.part`);
      await Deno.symlink(victim, `${at.base}.part`);
      await assertRejects(() => openPartial(at, true, 7), Error, "the partial file changed");
      assertEquals(await Deno.readTextFile(victim), "seven!!");
    }
    // The cache-dir location is named by the destination, inside the given directory.
    const cached = await partialAt(join(dir, "g.bin"), join(dir, "cache"));
    assert(cached.base.startsWith(join(dir, "cache", "denext-downloads")), cached.base);
    assertEquals((await partialAt(join(dir, "g.bin"), join(dir, "cache"))).base, cached.base);
    assert((await partialAt(join(dir, "h.bin"), join(dir, "cache"))).base !== cached.base);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- the download records (kept across restarts, as the native plugin keeps its own) ----------

/** The records file under `root`'s data dir. */
const recordsFile = (root: string) => join(root, "data", TRANSFER_RECORDS_DIR, "transfers.json");

/** What `listDownloads` answers. */
async function listed(cap: ReturnType<typeof fsCapability>): Promise<Record<string, unknown>[]> {
  return ((await call(cap, "listDownloads", {})) as { transfers: Record<string, unknown>[] })
    .transfers;
}

/** Wait until `data/<path>.part` holds `bytes` bytes (a held download's first chunk). */
async function waitForPart(root: string, path: string, bytes: number): Promise<void> {
  const part = join(root, "data", `${path}.part`);
  const end = Date.now() + 5_000;
  while ((await Deno.stat(part).then((i) => i.size, () => 0)) < bytes) {
    if (Date.now() > end) throw new Error("the first chunk never arrived");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Start download `id` of `url` to `data/<path>` on a held server, then pause it at 300 bytes. */
async function pausedAt300(
  cap: ReturnType<typeof fsCapability>,
  mode: ServerMode,
  root: string,
  id: string,
  path: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  mode.holdOnce = 300;
  const running = dl(cap, URL_A, path, { id, ...extra });
  running.catch(() => {});
  await waitForPart(root, path, 300);
  assertEquals(await call(cap, "pauseDownload", { id }), { paused: true });
  assertEquals(await rejectCode(running), "paused");
}

Deno.test({
  name:
    "records: a paused download survives a restart: listed, resumed from its partial with its headers",
}, async () => {
  const mode: ServerMode = { body: BODY, etag: '"v1"', honorRange: true };
  await withServer(mode, async (t) => {
    await pausedAt300(t.cap(), mode, t.root, "r1", "r.bin", {
      headers: { authorization: "Bearer t" },
    });
    // A restart: a new capability instance over the same data dir.
    const after = t.cap();
    assertEquals(await listed(after), [{
      id: "r1",
      kind: "download",
      url: URL_A,
      directory: "data",
      path: "r.bin",
      state: "paused",
      bytes: 300,
      total: 1000,
      resumable: true,
    }]);
    // The page that started it is gone: the resume sends no headers, the record's go.
    const out = await dl(after, URL_A, "r.bin", { id: "r1" }, "resumeDownload");
    assertEquals(out.bytes, 1000);
    assertEquals(await Deno.readFile(join(t.root, "data", "r.bin")), BODY);
    assertEquals(t.seen.at(-1), ["bytes=300-", '"v1"']);
    assertEquals(t.auths, ["Bearer t", "Bearer t"]);
    const [done] = await listed(after);
    assertEquals([done.state, done.bytes, done.total, done.file], ["done", 1000, 1000, out.path]);
    // Over for good: the record no longer keeps the request headers.
    assert(!(await Deno.readTextFile(recordsFile(t.root))).includes("Bearer"));
    assertEquals(await listed(t.cap()), [done], "done is listed after another restart");
  });
});

Deno.test({
  name: "records: a download running when the app quit comes back failed and resumable (as on iOS)",
}, async () => {
  const mode: ServerMode = { body: BODY, etag: '"v1"', honorRange: true, holdOnce: 300 };
  await withServer(mode, async (t) => {
    const first = t.cap();
    const running = dl(first, URL_A, "q.bin", { id: "q1", headers: { authorization: "Bearer q" } });
    running.catch(() => {});
    await waitForPart(t.root, "q.bin", 300);
    // The app quits here: the files on disk are as the running download left them.
    const atQuit = await Deno.readTextFile(recordsFile(t.root));
    assertEquals(JSON.parse(atQuit)[0].state, "running");
    // (The test stops the old instance's request, then puts the records back as the quit left them.)
    await call(first, "pauseDownload", { id: "q1" });
    await rejectCode(running);
    await Deno.writeTextFile(recordsFile(t.root), atQuit);

    const after = t.cap();
    const [r] = await listed(after);
    assertEquals([r.state, r.code, r.bytes, r.total, r.resumable], [
      "failed",
      "NETWORK",
      300,
      1000,
      true,
    ]);
    assertEquals(r.error, "the download stopped when the app quit");
    assertEquals((await dl(after, URL_A, "q.bin", { id: "q1" }, "resumeDownload")).bytes, 1000);
    assertEquals(t.seen.at(-1), ["bytes=300-", '"v1"']);
    assertEquals(t.auths.at(-1), "Bearer q");
    assertEquals(await Deno.readFile(join(t.root, "data", "q.bin")), BODY);
  });
});

Deno.test({
  name: "records: a cancel drops the record and the partial (after a restart too); done stays done",
}, async () => {
  const mode: ServerMode = { body: BODY, etag: '"v1"', honorRange: true };
  await withServer(mode, async (t) => {
    // Cancelled while running: nothing is left, the records folder included.
    const cap = t.cap();
    mode.holdOnce = 300;
    const running = dl(cap, URL_A, "c.bin", { id: "c1" });
    running.catch(() => {});
    await waitForPart(t.root, "c.bin", 300);
    assertEquals(await call(cap, "cancelDownload", { id: "c1" }), { cancelled: true });
    assertEquals(await rejectCode(running), "cancelled");
    assertEquals(await listed(cap), []);
    assertEquals(await namesIn(join(t.root, "data")), []);

    // Paused, restarted, then cancelled: the earlier launch's partial and record go.
    await pausedAt300(t.cap(), mode, t.root, "c2", "c.bin");
    const after = t.cap();
    assertEquals(await call(after, "cancelDownload", { id: "c2" }), { cancelled: true });
    assertEquals(await listed(after), []);
    assertEquals(await namesIn(join(t.root, "data")), []);
    assertEquals(await listed(t.cap()), [], "and it stays gone");
    assertEquals(await call(after, "cancelDownload", { id: "c2" }), { cancelled: false });

    // A cancel after the download finished is too late: its file and record stay.
    await dl(after, URL_A, "d.bin", { id: "d1" });
    assertEquals(await call(t.cap(), "cancelDownload", { id: "d1" }), { cancelled: false });
    assertEquals(await Deno.readFile(join(t.root, "data", "d.bin")), BODY);
    assertEquals((await listed(t.cap())).map((r) => [r.id, r.state]), [["d1", "done"]]);
  });
});

Deno.test({
  name:
    "records: a settled download is listed for the retention period, a paused one until it ends",
}, async () => {
  const mode: ServerMode = { body: BODY, etag: '"v1"', honorRange: true };
  await withServer(mode, async (t) => {
    const t0 = Date.now();
    const at = (ms: number) => t.cap({ transferClock: () => t0 + ms });
    await dl(at(0), URL_A, "old.bin", { id: "old" });
    await pausedAt300(at(0), mode, t.root, "live", "live.bin");
    const ids = async (ms: number) => (await listed(at(ms))).map((r) => [r.id, r.state]);
    assertEquals(await ids(SETTLED_RETENTION_MS - 60_000), [["live", "paused"], ["old", "done"]]);
    // Past the retention period the done record goes (its file stays: it is the user's).
    assertEquals(await ids(SETTLED_RETENTION_MS + 1), [["live", "paused"]]);
    assertEquals(await Deno.readFile(join(t.root, "data", "old.bin")), BODY);
    assertEquals(await ids(10 * SETTLED_RETENTION_MS), [["live", "paused"]]);
    // A record that was forgotten goes at once.
    const cap = at(0);
    assertEquals(await call(cap, "forgetDownload", { id: "live" }), { forgotten: false });
    assertEquals(await call(cap, "cancelDownload", { id: "live" }), { cancelled: true });
    assertEquals(await call(cap, "forgetDownload", { id: "live" }), { forgotten: false });
    await dl(cap, URL_A, "new.bin", { id: "new" });
    assertEquals(await call(cap, "forgetDownload", { id: "new" }), { forgotten: true });
    assertEquals(await listed(at(0)), []);
  });
});

Deno.test({
  name: "records SECURITY: the page's fs never reads, lists, writes or deletes the records folder",
}, async () => {
  const mode: ServerMode = { body: BODY, etag: '"v1"', honorRange: true };
  await withServer(mode, async (t) => {
    const cap = t.cap();
    await pausedAt300(cap, mode, t.root, "s1", "s.bin", { headers: { authorization: "Bearer s" } });
    const before = await Deno.readTextFile(recordsFile(t.root));
    const file = `${TRANSFER_RECORDS_DIR}/transfers.json`;
    for (const path of [file, file.toUpperCase(), `./${file}`, `x/../${file}`]) {
      const at = { path, directory: "data" };
      assertEquals(await rejectCode(call(cap, "readFile", at)), "forbidden", path);
      assertEquals(
        await rejectCode(call(cap, "writeFile", { ...at, data: "[]" })),
        "forbidden",
        path,
      );
      assertEquals(await rejectCode(call(cap, "deleteFile", at)), "forbidden", path);
      assertEquals(await rejectCode(dl(cap, URL_A, path)), "forbidden", path);
    }
    assertEquals(
      await rejectCode(call(cap, "listDir", { path: TRANSFER_RECORDS_DIR, directory: "data" })),
      "forbidden",
    );
    const root = await call(cap, "listDir", { path: "", directory: "data" }) as { name: string }[];
    assertEquals(root.map((e) => e.name).sort(), ["s.bin.part", "s.bin.part.json"]);
    assertEquals(await Deno.readTextFile(recordsFile(t.root)), before, "untouched");
    // Written for the user only.
    if (OS !== "windows") assertEquals((await Deno.stat(recordsFile(t.root))).mode! & 0o777, 0o600);
  });
});

/** The `fs` methods of `cap`, as a fake bridge serves them (its events through `emit`). */
function bridged(
  cap: ReturnType<typeof fsCapability>,
  emit: (event: string, data: unknown) => void,
): Record<string, FakeMethod> {
  const out: Record<string, FakeMethod> = {};
  for (const name of Object.keys(cap.methods)) {
    out[name] = (args) => cap.methods[name].handler(args, ctx({ emit }));
  }
  return out;
}

Deno.test({
  name:
    "records: after a restart the page lists, resumes, cancels and forgets the earlier downloads",
}, async () => {
  const mode: ServerMode = { body: BODY, etag: '"v1"', honorRange: true };
  await withServer(mode, async (t) => {
    await pausedAt300(t.cap(), mode, t.root, "pg", "pg.bin");
    await pausedAt300(t.cap(), mode, t.root, "pc", "pc.bin");
    const after = t.cap();
    const rt = createFakeDesktopRuntime({
      fs: bridged(after, (event, data) => rt.emit("fs", event, data)),
    });
    const restore = rt.install();
    resetFileTransfersForTesting();
    const events: FileTransferEvent[] = [];
    const stop = onFileTransfer((e) => events.push(e));
    try {
      const shape = (x: { id: string; state: string; bytes: number; resumable: boolean }) => [
        x.id,
        x.state,
        x.bytes,
        x.resumable,
      ];
      assertEquals((await fileTransfers()).map(shape), [
        ["pc", "paused", 300, true],
        ["pg", "paused", 300, true],
      ]);
      const [pg] = (await fileTransfers()).filter((x) => x.id === "pg");
      assertEquals([pg.kind, pg.url, pg.directory, pg.path, pg.total], [
        "download",
        URL_A,
        "data",
        "pg.bin",
        1000,
      ]);

      assert(await resumeFileTransfer("pg"));
      assertEquals(await resumeFileTransfer("pg"), false, "it runs: a second resume is refused");
      await until(() => events.some((e) => e.id === "pg" && e.type === "done"));
      assertEquals(events[0].type, "started");
      assertEquals(events[0].bytes, 300);
      const done = events.find((e) => e.id === "pg" && e.type === "done")!;
      assertEquals(await Deno.readFile(done.file!), BODY);
      assertEquals(t.seen.at(-1), ["bytes=300-", '"v1"']);

      assert(await cancelFileTransfer("pc"));
      assertEquals(events.at(-1)?.type, "cancelled");
      assertEquals(events.at(-1)?.id, "pc");
      assertEquals(await namesIn(join(t.root, "data")), [TRANSFER_RECORDS_DIR, "pg.bin"]);
      assertEquals((await fileTransfers()).map((x) => [x.id, x.state]), [["pg", "done"]]);

      assert(await forgetFileTransfer("pg"));
      assertEquals(await fileTransfers(), []);
      assertEquals(await listed(t.cap()), [], "forgotten in the runtime too");
    } finally {
      stop();
      resetDesktopBridgeForTesting();
      restore();
      resetFileTransfersForTesting();
    }
  });
});
