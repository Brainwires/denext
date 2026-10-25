// denext/mobile file transfers: `downloadToFile` / `uploadFile` with progress, and the controls
// (pause, resume, cancel, list, forget, onFileTransfer). In a faked shell with denext's
// DenextTransfer plugin the transfer is the plugin's (asserting the exact `start` call and
// settling on its events); on the web it runs in the page against a fake OPFS, a streaming fake
// `fetch` (pause, then a range-request resume) and a fake XMLHttpRequest (upload progress).

import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import {
  cancelFileTransfer,
  downloadToFile,
  FileTransferError,
  type FileTransferEvent,
  type FileTransferProgress,
  fileTransfers,
  forgetFileTransfer,
  onFileTransfer,
  pauseFileTransfer,
  readFile,
  resumeFileTransfer,
  uploadFile,
  writeFile,
} from "../src/mobile/mod.ts";
import { ifRangeValidator, resetFileTransfersForTesting } from "../src/mobile/file-transfer.ts";
import {
  type Any,
  fakePlugin,
  inShell,
  settle,
  until,
  withGlobals,
} from "./helpers/mobile-fakes.ts";

const TRANSFER = ["start", "pause", "resume", "cancel", "forget", "list"];

/** The arguments of every call to `method`. */
function callsTo(fake: ReturnType<typeof fakePlugin>, method: string): Any[] {
  return fake.calls.filter(([m]) => m === method).map(([, arg]) => arg);
}

// ---- a fake OPFS whose writable streams append at a cursor, as the real ones do --------------

class FakeFile {
  readonly kind = "file" as const;
  bytes = new Uint8Array(0);
  constructor(public name: string) {}
  getFile(): Promise<File> {
    return Promise.resolve(new File([this.bytes.slice()], this.name));
  }
  createWritable(opts?: { keepExistingData?: boolean }): Promise<Any> {
    let data = opts?.keepExistingData ? this.bytes.slice() : new Uint8Array(0);
    let at = 0;
    return Promise.resolve({
      seek: (n: number) => void (at = n),
      write: (chunk: string | Uint8Array) => {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        const next = new Uint8Array(Math.max(data.length, at + bytes.length));
        next.set(data);
        next.set(bytes, at);
        data = next;
        at += bytes.length;
        return Promise.resolve();
      },
      close: () => {
        this.bytes = data;
        return Promise.resolve();
      },
    });
  }
}

class FakeDir {
  readonly kind = "directory" as const;
  children = new Map<string, FakeFile | FakeDir>();
  constructor(public name: string) {}
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<Any> {
    let child = this.children.get(name);
    if (!child && opts?.create) this.children.set(name, child = new FakeDir(name));
    if (!child) return Promise.reject(new DOMException(name, "NotFoundError"));
    return Promise.resolve(child);
  }
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<Any> {
    let child = this.children.get(name);
    if (!child && opts?.create) this.children.set(name, child = new FakeFile(name));
    if (!child) return Promise.reject(new DOMException(name, "NotFoundError"));
    return Promise.resolve(child);
  }
  removeEntry(name: string): Promise<void> {
    this.children.delete(name);
    return Promise.resolve();
  }
}

function withOpfs(fn: () => Promise<void>, extra: Record<string, unknown> = {}): Promise<void> {
  const root = new FakeDir("");
  const navigator = { storage: { getDirectory: () => Promise.resolve(root) } };
  return withGlobals({ navigator, isSecureContext: true, ...extra }, async () => {
    try {
      await fn();
    } finally {
      resetFileTransfersForTesting();
    }
  });
}

/** `size` bytes where byte i is i % 251. */
function pattern(size: number, from = 0): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size - from);
  for (let i = from; i < size; i++) out[i - from] = i % 251;
  return out;
}

/**
 * A fetch serving `size` bytes in 1 KiB chunks, one chunk per `gate()` the test opens (so it can
 * pause part-way). Ranges are honoured unless `ignoreRange`; requests are recorded.
 */
function streamingFetch(
  size: number,
  opts: { ignoreRange?: boolean; validators?: Record<string, string> } = {},
) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  let release: (() => void) | null = null;
  let pending = 0;
  const gate = () => new Promise<void>((resolve) => (release = resolve));
  const fetch = (url: string, init: { headers?: HeadersInit; signal?: AbortSignal } = {}) => {
    const headers = new Headers(init.headers);
    requests.push({ url, headers });
    const range = /^bytes=(\d+)-$/.exec(headers.get("range") ?? "");
    const start = range && !opts.ignoreRange ? Number(range[1]) : 0;
    let at = start;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      async pull(controller) {
        if (at >= size) return controller.close();
        pending++;
        await gate();
        pending--;
        if (init.signal?.aborted) return controller.error(init.signal.reason);
        const end = Math.min(size, at + 1024);
        controller.enqueue(pattern(end, at));
        at = end;
      },
    });
    init.signal?.addEventListener("abort", () => release?.());
    const partial = start > 0;
    return Promise.resolve(
      new Response(body, {
        status: partial ? 206 : 200,
        headers: {
          ...(opts.validators ?? { etag: '"e1"' }),
          "content-length": String(size - start),
          ...(partial ? { "content-range": `bytes ${start}-${size - 1}/${size}` } : {}),
        },
      }),
    );
  };
  return {
    fetch,
    requests,
    /** Let `n` chunks through. */
    async step(n = 1) {
      for (let i = 0; i < n; i++) {
        await until(() => pending > 0 && release !== null, "the next chunk to be asked for");
        const r = release!;
        release = null;
        r();
        await settle();
      }
    },
    /** Let every chunk through. */
    async drain() {
      while (true) {
        try {
          await until(() => pending > 0 && release !== null, "a chunk", 200);
        } catch {
          return;
        }
        const r = release!;
        release = null;
        r();
        await settle();
      }
    },
  };
}

// ---- the native plugin ---------------------------------------------------------------------

Deno.test("downloadToFile (shell): starts the plugin's background transfer and settles on its events", async () => {
  const fake = fakePlugin(TRANSFER, { start: { id: "d1" } });
  const progress: FileTransferProgress[] = [];
  await inShell("ios", { DenextTransfer: fake.plugin }, async () => {
    const done = downloadToFile("https://cdn.test/a.pdf", "docs/a.pdf", {
      id: "d1",
      directory: "documents",
      headers: { authorization: "Bearer t" },
      onProgress: (p) => progress.push(p),
    });
    await settle();
    fake.fire("transfer", { id: "d1", type: "progress", kind: "download", bytes: 10, total: 40 });
    fake.fire("transfer", { id: "other", type: "progress", kind: "download", bytes: 99 });
    fake.fire("transfer", {
      id: "d1",
      type: "done",
      kind: "download",
      state: "done",
      bytes: 40,
      total: 40,
      file: "/var/mobile/Documents/docs/a.pdf",
    });
    assertEquals(await done, { path: "/var/mobile/Documents/docs/a.pdf" });
  });
  assertEquals(callsTo(fake, "start"), [{
    id: "d1",
    kind: "download",
    url: "https://cdn.test/a.pdf",
    directory: "DOCUMENTS",
    path: "docs/a.pdf",
    method: "GET",
    headers: { authorization: "Bearer t" },
    background: true,
  }]);
  assertEquals(progress, [
    { id: "d1", kind: "download", bytes: 10, total: 40 },
    { id: "d1", kind: "download", bytes: 40, total: 40 },
  ]);
  resetFileTransfersForTesting();
});

Deno.test("uploadFile (shell): a multipart upload from the file, its type from the extension", async () => {
  const fake = fakePlugin(TRANSFER, { start: { id: "u1" } });
  await inShell("android", { DenextTransfer: fake.plugin }, async () => {
    const done = uploadFile("https://api.test/photos", "camera/1.jpg", {
      id: "u1",
      field: "photo",
      fields: { album: "trip" },
      background: false,
    });
    await settle();
    fake.fire("transfer", {
      id: "u1",
      type: "done",
      kind: "upload",
      state: "done",
      bytes: 5,
      status: 201,
      body: '{"ok":true}',
      headers: { "Content-Type": "application/json" },
    });
    assertEquals(await done, {
      status: 201,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
  });
  assertEquals(callsTo(fake, "start"), [{
    id: "u1",
    kind: "upload",
    url: "https://api.test/photos",
    directory: "DATA",
    path: "camera/1.jpg",
    method: "POST",
    headers: {},
    multipart: {
      field: "photo",
      fileName: "1.jpg",
      fields: { album: "trip" },
      mimeType: "image/jpeg",
    },
    mimeType: "image/jpeg",
    background: false,
  }]);
  // A binary PUT: no multipart framing, the given type.
  const put = fakePlugin(TRANSFER, { start: { id: "u2" } });
  await inShell("ios", { DenextTransfer: put.plugin }, async () => {
    const done = uploadFile("https://s3.test/key", "a.bin", {
      id: "u2",
      method: "PUT",
      as: "binary",
      mimeType: "application/x-thing",
    });
    await settle();
    put.fire("transfer", { id: "u2", type: "done", kind: "upload", status: 200 });
    assertEquals((await done).status, 200);
  });
  const start = callsTo(put, "start")[0];
  assertEquals([start.method, start.multipart, start.mimeType], [
    "PUT",
    undefined,
    "application/x-thing",
  ]);
  resetFileTransfersForTesting();
});

Deno.test("file transfers (shell): failures, a refused start and an aborted signal reject", async () => {
  const fake = fakePlugin(TRANSFER, { start: { id: "x" } });
  await inShell("ios", { DenextTransfer: fake.plugin }, async () => {
    const failed = downloadToFile("https://cdn.test/404", "a.bin", { id: "f1" });
    await settle();
    fake.fire("transfer", {
      id: "f1",
      type: "failed",
      state: "failed",
      code: "HTTP",
      status: 404,
      body: "nope",
      error: "the server answered 404",
    });
    const err = await assertRejects(() => failed, FileTransferError, "answered 404");
    assertEquals([err.code, err.status, err.body, err.id, err.resumable], [
      "HTTP",
      404,
      "nope",
      "f1",
      false,
    ]);
    const network = downloadToFile("https://cdn.test/big", "b.bin", { id: "f2" });
    await settle();
    fake.fire("transfer", { id: "f2", type: "failed", code: "NETWORK", resumable: true });
    assertEquals((await assertRejects(() => network, FileTransferError)).resumable, true);
    // The caller's signal cancels it natively and rejects with the signal's reason.
    const controller = new AbortController();
    const aborted = downloadToFile("https://cdn.test/c", "c.bin", {
      id: "f3",
      signal: controller.signal,
    });
    await settle();
    controller.abort(new Error("user left"));
    await settle();
    assertEquals(callsTo(fake, "cancel"), [{ id: "f3" }]);
    fake.fire("transfer", { id: "f3", type: "cancelled", state: "cancelled" });
    await assertRejects(() => aborted, Error, "user left");
    // cancelFileTransfer from elsewhere: CANCELLED.
    const cancelled = uploadFile("https://api.test/u", "c.bin", { id: "f4" });
    await settle();
    fake.fire("transfer", { id: "f4", type: "cancelled" });
    assertEquals((await assertRejects(() => cancelled, FileTransferError)).code, "CANCELLED");
  });
  const refusing = fakePlugin(TRANSFER, {
    start: Object.assign(new Error("no file at gone.bin"), { code: "NOT_FOUND" }),
  });
  await inShell("android", { DenextTransfer: refusing.plugin }, async () => {
    const err = await assertRejects(
      () => uploadFile("https://api.test/u", "gone.bin"),
      FileTransferError,
      "no file at gone.bin",
    );
    assertEquals(err.code, "NOT_FOUND");
  });
  resetFileTransfersForTesting();
});

Deno.test("file transfers (shell): the controls and the list are the plugin's; events reach onFileTransfer", async () => {
  const fake = fakePlugin(TRANSFER, {
    pause: { paused: true },
    resume: { resumed: true },
    cancel: { cancelled: false },
    forget: { forgotten: true },
    list: {
      transfers: [
        {
          id: "bg",
          kind: "download",
          url: "https://cdn.test/a",
          directory: "CACHE",
          path: "a",
          state: "done",
          bytes: 3,
          total: 3,
          resumable: false,
          file: "/c/a",
        },
        { id: "up", kind: "upload", directory: "DATA", path: "b", state: "running", bytes: 1 },
      ],
    },
  });
  const seen: FileTransferEvent[] = [];
  await inShell("ios", { DenextTransfer: fake.plugin }, async () => {
    assertEquals(await pauseFileTransfer("bg"), true);
    assertEquals(await resumeFileTransfer("bg"), true);
    assertEquals(await cancelFileTransfer("bg"), false);
    assertEquals(await forgetFileTransfer("bg"), true);
    assertEquals(await fileTransfers(), [
      {
        id: "bg",
        kind: "download",
        url: "https://cdn.test/a",
        directory: "cache",
        path: "a",
        state: "done",
        bytes: 3,
        total: 3,
        resumable: false,
        file: "/c/a",
      },
      {
        id: "up",
        kind: "upload",
        url: "",
        directory: "data",
        path: "b",
        state: "running",
        bytes: 1,
        total: null,
        resumable: false,
      },
    ]);
    // A transfer from before a relaunch: its events reach every listener.
    const stop = onFileTransfer((e) => seen.push(e));
    await settle();
    fake.fire("transfer", { id: "bg2", type: "progress", kind: "download", bytes: 7, total: 9 });
    stop();
    fake.fire("transfer", { id: "bg2", type: "done", kind: "download", bytes: 9 });
  });
  assertEquals(seen.map((e) => [e.id, e.type, e.bytes, e.total]), [["bg2", "progress", 7, 9]]);
  for (const m of ["pause", "resume", "cancel", "forget"]) {
    assertEquals(callsTo(fake, m), [{ id: "bg" }]);
  }
  resetFileTransfersForTesting();
});

// ---- the page --------------------------------------------------------------------------------

Deno.test("downloadToFile (web): streams into OPFS with progress, pauses and resumes with a range", async () => {
  const server = streamingFetch(5 * 1024);
  await withOpfs(async () => {
    const progress: number[] = [];
    const events: string[] = [];
    const stop = onFileTransfer((e) => events.push(`${e.type}:${e.bytes}`));
    const done = downloadToFile("https://x.test/f.bin", "dl/f.bin", {
      id: "w1",
      onProgress: (p) => progress.push(p.bytes),
    });
    await server.step(2);
    assertEquals(await pauseFileTransfer("w1"), true);
    await until(() => events.some((e) => e.startsWith("paused")), "the pause");
    const paused = (await fileTransfers()).find((t) => t.id === "w1");
    assertEquals([paused?.state, paused?.bytes, paused?.resumable], ["paused", 2048, true]);
    assertEquals(await pauseFileTransfer("w1"), false); // already paused
    assertEquals(await resumeFileTransfer("w1"), true);
    await server.drain();
    assertEquals(await done, { path: "data/dl/f.bin" });
    stop();
    // The resume asked for the rest, guarded by the validator.
    assertEquals(server.requests.length, 2);
    assertEquals(server.requests[1].headers.get("range"), "bytes=2048-");
    assertEquals(server.requests[1].headers.get("if-range"), '"e1"');
    const file = await readFile("dl/f.bin", { encoding: "base64" });
    assertEquals(atob(file).length, 5 * 1024);
    assertEquals(
      Uint8Array.from(atob(file), (c) => c.charCodeAt(0)),
      pattern(5 * 1024),
    );
    // Throttled (100 ms), but the start, the resume and the end are always reported, in order.
    assertEquals([progress[0], progress.at(-1)], [0, 5 * 1024]);
    assert(progress.includes(2048), String(progress));
    assert(progress.every((b, i) => i === 0 || b >= progress[i - 1]), String(progress));
    assertEquals(events[0], "started:0");
    assertEquals(events.at(-1), "done:5120");
    const info = (await fileTransfers()).find((t) => t.id === "w1");
    assertEquals([info?.state, info?.file, info?.total], ["done", "data/dl/f.bin", 5120]);
    assertEquals(await forgetFileTransfer("w1"), true);
    assertEquals((await fileTransfers()).length, 0);
  }, { fetch: server.fetch });
});

Deno.test("ifRangeValidator: a strong ETag, else Last-Modified; a weak ETag is never sent", () => {
  const date = "Wed, 21 Oct 2026 07:28:00 GMT";
  const v = (h: Record<string, string>) => ifRangeValidator(new Headers(h));
  assertEquals(v({ etag: '"abc"', "last-modified": date }), '"abc"');
  assertEquals(v({ etag: 'W/"abc"', "last-modified": date }), date);
  assertEquals(v({ etag: 'W/"abc"' }), null);
  assertEquals(v({ "last-modified": date }), date);
  assertEquals(v({}), null);
});

Deno.test("downloadToFile (web): a weak ETag resumes on Last-Modified, not from zero", async () => {
  const date = "Wed, 21 Oct 2026 07:28:00 GMT";
  const server = streamingFetch(3 * 1024, {
    validators: { etag: 'W/"weak"', "last-modified": date },
  });
  await withOpfs(async () => {
    const done = downloadToFile("https://x.test/w.bin", "w.bin", { id: "w9" });
    await server.step(1);
    await pauseFileTransfer("w9");
    await until(() => server.requests.length === 1);
    await settle();
    assertEquals(await resumeFileTransfer("w9"), true);
    await server.drain();
    assertEquals(await done, { path: "data/w.bin" });
    assertEquals(server.requests[1].headers.get("range"), "bytes=1024-");
    assertEquals(server.requests[1].headers.get("if-range"), date);
    const file = await readFile("w.bin", { encoding: "base64" });
    assertEquals(Uint8Array.from(atob(file), (c) => c.charCodeAt(0)), pattern(3 * 1024));
    await forgetFileTransfer("w9");
  }, { fetch: server.fetch });
});

Deno.test("downloadToFile (web): a server that ignores the range starts it over", async () => {
  const server = streamingFetch(3 * 1024, { ignoreRange: true });
  await withOpfs(async () => {
    const done = downloadToFile("https://x.test/g.bin", "g.bin", { id: "w2" });
    await server.step(1);
    await pauseFileTransfer("w2");
    await until(() => server.requests.length === 1);
    await settle();
    assertEquals(await resumeFileTransfer("w2"), true);
    await server.drain();
    await done;
    const bytes = Uint8Array.from(
      atob(await readFile("g.bin", { encoding: "base64" })),
      (c) => c.charCodeAt(0),
    );
    assertEquals(bytes, pattern(3 * 1024));
  }, { fetch: server.fetch });
});

Deno.test("downloadToFile (web): cancel, a caller's signal, an HTTP error and a duplicate id", async () => {
  const server = streamingFetch(4 * 1024);
  await withOpfs(async () => {
    // Cancelled while running.
    const running = downloadToFile("https://x.test/a", "a.bin", { id: "c1" });
    await server.step(1);
    assertEquals(await cancelFileTransfer("c1"), true);
    assertEquals((await assertRejects(() => running, FileTransferError)).code, "CANCELLED");
    // Cancelled while paused.
    const paused = downloadToFile("https://x.test/b", "b.bin", { id: "c2" });
    await server.step(1);
    await pauseFileTransfer("c2");
    await settle();
    await settle();
    assertEquals(await cancelFileTransfer("c2"), true);
    assertEquals((await assertRejects(() => paused, FileTransferError)).code, "CANCELLED");
    assertEquals(await cancelFileTransfer("c2"), false);
    // The caller's own signal: its reason.
    const controller = new AbortController();
    const signalled = downloadToFile("https://x.test/c", "c.bin", {
      id: "c3",
      signal: controller.signal,
    });
    await server.step(1);
    controller.abort(new Error("navigated away"));
    await assertRejects(() => signalled, Error, "navigated away");
    // An id already running is refused.
    const first = downloadToFile("https://x.test/d", "d.bin", { id: "c4" });
    await server.step(1);
    const dup = await assertRejects(
      () => downloadToFile("https://x.test/d", "d2.bin", { id: "c4" }),
      FileTransferError,
      "already running",
    );
    assertEquals(dup.code, "EXISTS");
    await cancelFileTransfer("c4");
    await assertRejects(() => first);
  }, { fetch: server.fetch });
  const notFound = () => Promise.resolve(new Response("gone", { status: 410 }));
  await withOpfs(async () => {
    const err = await assertRejects(
      () => downloadToFile("https://x.test/z", "z.bin"),
      FileTransferError,
      "answered 410",
    );
    assertEquals([err.code, err.status, err.body], ["HTTP", 410, "gone"]);
  }, { fetch: notFound });
});

/** A fake XMLHttpRequest that reports upload progress and answers `status` with `body`. */
function fakeXhr(status: number, body: string) {
  const sent: Array<
    { method: string; url: string; headers: Record<string, string>; body: unknown }
  > = [];
  class Xhr {
    upload = { onprogress: null as ((e: Any) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = "";
    #req = { method: "", url: "", headers: {} as Record<string, string>, body: null as unknown };
    open(method: string, url: string) {
      this.#req.method = method;
      this.#req.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.#req.headers[name] = value;
    }
    getAllResponseHeaders() {
      return "Content-Type: application/json\r\nX-Id: 7\r\n";
    }
    send(payload: unknown) {
      this.#req.body = payload;
      sent.push(this.#req);
      queueMicrotask(() => {
        this.upload.onprogress?.({ loaded: 50, total: 100, lengthComputable: true });
        this.upload.onprogress?.({ loaded: 100, total: 100, lengthComputable: true });
        this.status = status;
        this.responseText = body;
        this.onload?.();
      });
    }
    abort() {
      this.onabort?.();
    }
  }
  return { Xhr, sent };
}

Deno.test("uploadFile (web): multipart through XMLHttpRequest with progress; a binary PUT; errors", async () => {
  const ok = fakeXhr(200, '{"id":7}');
  await withOpfs(async () => {
    await writeFile("pics/cat.png", "PNGDATA", { recursive: true });
    const progress: FileTransferProgress[] = [];
    const res = await uploadFile("https://api.test/up", "pics/cat.png", {
      id: "p1",
      fields: { album: "pets" },
      headers: { "x-token": "t" },
      onProgress: (p) => progress.push(p),
    });
    assertEquals(res, {
      status: 200,
      headers: { "content-type": "application/json", "x-id": "7" },
      body: '{"id":7}',
    });
    const req = ok.sent[0];
    assertEquals([req.method, req.url, req.headers], ["POST", "https://api.test/up", {
      "x-token": "t",
    }]);
    const form = req.body as FormData;
    assertInstanceOf(form, FormData);
    assertEquals(form.get("album"), "pets");
    const file = form.get("file") as File;
    assertEquals([file.name, await file.text()], ["cat.png", "PNGDATA"]);
    // Throttled to one per 100 ms: the start, then the end (the body as sent, framing included).
    assertEquals(progress.map((p) => [p.bytes, p.total]), [[0, 7], [100, 100]]);
    // A binary PUT: the file is the body, with its type.
    await uploadFile("https://s3.test/k", "pics/cat.png", { method: "PUT", as: "binary" });
    const put = ok.sent[1];
    assertEquals([put.method, put.headers["content-type"]], ["PUT", "image/png"]);
    assertInstanceOf(put.body, Blob);
    await assertRejects(
      () => uploadFile("https://api.test/up", "pics/cat.png", { method: "GET" as Any }),
      TypeError,
      "POST, PUT or PATCH",
    );
    await assertRejects(() => uploadFile("ftp://x/y", "pics/cat.png"), TypeError, "http(s)");
    await assertRejects(() => uploadFile("https://x/y", "../cat.png"), TypeError, "relative");
  }, { XMLHttpRequest: ok.Xhr });
  const denied = fakeXhr(403, "forbidden");
  await withOpfs(async () => {
    await writeFile("a.txt", "x");
    const err = await assertRejects(
      () => uploadFile("https://api.test/up", "a.txt"),
      FileTransferError,
      "answered 403",
    );
    assertEquals([err.code, err.status, err.body], ["HTTP", 403, "forbidden"]);
  }, { XMLHttpRequest: denied.Xhr });
});

Deno.test("uploadFile (web): without XMLHttpRequest it posts with fetch; an aborted signal rejects", async () => {
  const seen: Array<{ url: string; init: Any }> = [];
  const fetch = (url: string, init: Any) => {
    seen.push({ url, init });
    return Promise.resolve(new Response("stored", { status: 201 }));
  };
  await withOpfs(async () => {
    await writeFile("n.txt", "hello");
    const res = await uploadFile("https://api.test/n", "n.txt", { as: "binary", method: "PATCH" });
    assertEquals([res.status, res.body], [201, "stored"]);
    assertEquals([seen[0].init.method, seen[0].init.headers["content-type"]], [
      "PATCH",
      "text/plain",
    ]);
    assertEquals(await (seen[0].init.body as Blob).text(), "hello");
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await assertRejects(
      () => uploadFile("https://api.test/n", "n.txt", { signal: controller.signal }),
      Error,
      "stop",
    );
  }, { fetch, XMLHttpRequest: undefined });
});
