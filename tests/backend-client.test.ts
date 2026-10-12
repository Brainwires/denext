// @denext/backend/client in a browser-like global: `uploadFile` sends the bytes with
// XMLHttpRequest (upload progress events, error envelopes, aborts) against the fs driver,
// through the real plugin pipeline; `getFileUrl` and the error type.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { backendApp, ORIGIN } from "./_backend-app.ts";
import { getFileUrl, StorageClientError, uploadFile } from "../packages/backend/client.ts";

type Handler = (request: Request) => Promise<Response>;

/** A minimal XMLHttpRequest over the app handler, with upload progress in two steps. */
function fakeXhr(handler: Handler, mode: { fail?: "network" | "hang" } = {}) {
  return class FakeXHR {
    status = 0;
    responseText = "";
    upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    #method = "GET";
    #url = "";
    #headers = new Headers();
    #response: Response | null = null;
    #aborted = false;
    open(method: string, url: string) {
      this.#method = method;
      this.#url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.#headers.set(name, value);
    }
    getResponseHeader(name: string) {
      return this.#response?.headers.get(name) ?? null;
    }
    abort() {
      this.#aborted = true;
      this.onabort?.();
    }
    async send(body: Blob) {
      if (mode.fail === "network") return queueMicrotask(() => this.onerror?.());
      this.upload.onprogress?.({ loaded: Math.floor(body.size / 2) });
      if (mode.fail === "hang") return;
      this.#headers.set("host", new URL(ORIGIN).host);
      this.#response = await handler(
        new Request(new URL(this.#url, ORIGIN), {
          method: this.#method,
          headers: this.#headers,
          body,
        }),
      );
      if (this.#aborted) return;
      this.status = this.#response.status;
      this.responseText = await this.#response.text();
      this.onload?.();
    }
  };
}

function withBrowser<T>(
  handler: Handler,
  fn: () => Promise<T>,
  mode: { fail?: "network" | "hang" } = {},
): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const originalFetch = globalThis.fetch;
  g.XMLHttpRequest = fakeXhr(handler, mode);
  g.__denextBasePath = "";
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("host", new URL(ORIGIN).host);
    headers.set("origin", ORIGIN);
    return handler(new Request(new URL(String(input), ORIGIN), { ...init, headers }));
  }) as typeof fetch;
  return fn().finally(() => {
    delete g.XMLHttpRequest;
    delete g.__denextBasePath;
    globalThis.fetch = originalFetch;
  });
}

Deno.test("client: uploadFile over XMLHttpRequest reports progress; getFileUrl signs a download", async () => {
  const app = await backendApp({
    buckets: { docs: { mime: ["text/plain"], authorize: () => true } },
  });
  try {
    const progress: number[] = [];
    const file = new File(["hello client"], "note.txt", { type: "text/plain" });
    const stored = await withBrowser(
      app.handler,
      () =>
        uploadFile("docs", file, {
          onProgress: ({ loaded, total }) => progress.push(loaded / total),
        }),
    );
    assert(/^[0-9a-f-]{36}\.txt$/.test(stored.key));
    assertEquals([stored.size, stored.contentType], [12, "text/plain"]);
    assertEquals(progress, [0.5, 1]);
    const url = await withBrowser(app.handler, () => getFileUrl("docs", stored.key));
    assertEquals(await (await app.call(url)).text(), "hello client");
    // A blob with no type uploads as octet-stream, which this bucket refuses at signing.
    const err = await withBrowser(
      app.handler,
      () => assertRejects(() => uploadFile("docs", new Blob(["x"])), StorageClientError),
    );
    assertEquals([err.code, err.status], ["mime_not_allowed", 415]);
  } finally {
    await app.close();
  }
});

Deno.test("client: an upload refused by the PUT surfaces its error envelope", async () => {
  const app = await backendApp({
    buckets: { img: { mime: ["image/png"], authorize: () => true } },
  });
  try {
    const fake = new File(["<html>"], "x.png", { type: "image/png" });
    const err = await withBrowser(
      app.handler,
      () => assertRejects(() => uploadFile("img", fake, { key: "x.png" }), StorageClientError),
    );
    assertEquals([err.code, err.status], ["mime_mismatch", 415]);
    // A non-JSON failure keeps the status.
    const plain = await withBrowser(
      () => Promise.resolve(new Response("nope", { status: 502 })),
      () => assertRejects(() => getFileUrl("img", "x.png"), StorageClientError),
    );
    assertEquals([plain.code, plain.status, plain.message], ["http_error", 502, "nope"]);
    const net = await withBrowser(
      app.handler,
      () =>
        assertRejects(
          () => uploadFile("img", new File([new Uint8Array(8)], "a.png", { type: "image/png" })),
          StorageClientError,
        ),
      { fail: "network" },
    );
    assertEquals(net.code, "network_error");
    const html = await withBrowser(
      (r) =>
        Promise.resolve(
          new URL(r.url).pathname.endsWith("/sign")
            ? Response.json({ upload: { url: "/put", headers: {}, token: "t" } })
            : new Response("<html>", { status: 500 }),
        ),
      () => assertRejects(() => uploadFile("img", new Blob(["x"])), StorageClientError),
    );
    assertEquals([html.code, html.status], ["http_error", 500]);
  } finally {
    await app.close();
  }
});

Deno.test("client: an AbortSignal cancels an in-flight upload", async () => {
  const app = await backendApp({ buckets: { docs: { authorize: () => true } } });
  try {
    const controller = new AbortController();
    const pending = withBrowser(
      app.handler,
      () =>
        uploadFile("docs", new Blob(["abc"]), {
          signal: controller.signal,
          endpoint: "/_denext/storage/",
        }),
      { fail: "hang" },
    );
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const err = await assertRejects(() => pending);
    assertEquals((err as DOMException).name, "AbortError");
  } finally {
    await app.close();
  }
});
