// denext/mobile capabilities, second set: the filesystem functions, pickImage / pickDocument,
// scanBarcode and quick actions. Each runs inside a faked Capacitor shell (`globalThis.Capacitor`
// with the plugin's methods under `Plugins`), asserting the exact plugin call, and on its web
// fallback (a fake OPFS, a fake file input, a fake BarcodeDetector + camera). Every global a
// test installs is restored.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import { makeDom } from "./helpers/dom.ts";
import {
  deleteFile,
  downloadToFile,
  listDir,
  onQuickAction,
  pickDocument,
  pickImage,
  readFile,
  scanBarcode,
  setQuickActions,
  useQuickAction,
  writeFile,
} from "../src/mobile/mod.ts";
import { resetQuickActionsForTesting } from "../src/mobile/quick-actions.ts";
import { base64ToBytes, bytesToBase64 } from "../src/mobile/base64.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const g = globalThis as Any;

/** Install `values` on globalThis for the duration of `fn`, then restore the originals. */
async function withGlobals(
  values: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(g, key));
    Object.defineProperty(g, key, { configurable: true, writable: true, value });
  }
  try {
    await fn();
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(g, key, desc);
      else delete g[key];
    }
  }
}

/** Run `fn` inside a native iOS shell whose `Plugins` are `plugins`. */
function inShell(
  plugins: Record<string, unknown>,
  fn: () => unknown | Promise<unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: plugins };
  return withGlobals({ Capacitor, ...extra }, fn);
}

/** A recorder: `calls` collects `[method, arg]`; each method resolves (or rejects) `results[method]`. */
function recorder(methods: string[], results: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const plugin: Record<string, (arg?: unknown) => Promise<unknown>> = {};
  for (const m of methods) {
    plugin[m] = (arg?: unknown) => {
      calls.push([m, arg]);
      const r = results[m];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    };
  }
  return { plugin, calls };
}

/** An Error carrying a plugin `code`. */
function pluginError(message: string, code?: string): Error {
  return Object.assign(new Error(message), code ? { code } : {});
}

// ---- base64 helpers ----------------------------------------------------------

Deno.test("base64: round-trips bytes, including a data: URL prefix and large input", () => {
  const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
  const b64 = bytesToBase64(bytes);
  assertEquals(base64ToBytes(b64), bytes);
  assertEquals(
    base64ToBytes(`data:image/png;base64,${bytesToBase64(bytes.slice(0, 3))}`),
    bytes.slice(0, 3),
  );
});

// ---- filesystem --------------------------------------------------------------

const FS_METHODS = ["readFile", "writeFile", "deleteFile", "readdir", "downloadFile"];

Deno.test("filesystem: native calls carry the Directory enum values and the encoding", async () => {
  const { plugin, calls } = recorder(FS_METHODS, {
    readFile: { data: "hello" },
    readdir: {
      files: [
        { name: "b.txt", type: "file", size: 5, mtime: 7, uri: "file:///b" },
        { name: "a", type: "directory", size: 0, mtime: 3, uri: "file:///a" },
      ],
    },
    downloadFile: { path: "/var/mobile/Documents/m.pdf" },
  });
  await inShell({ Filesystem: plugin }, async () => {
    assertEquals(await readFile("notes/a.md"), "hello");
    await readFile("img.png", { directory: "cache", encoding: "base64" });
    await writeFile("notes/a.md", "hi", { recursive: true });
    await writeFile("img.png", "AAEC", { directory: "documents", encoding: "base64" });
    await deleteFile("/notes//a.md".slice(1));
    assertEquals(await listDir(""), [
      { name: "a", type: "directory", size: 0, mtime: 3 },
      { name: "b.txt", type: "file", size: 5, mtime: 7 },
    ]);
    assertEquals(
      await downloadToFile("https://example.com/m.pdf", "m.pdf", { directory: "documents" }),
      { path: "/var/mobile/Documents/m.pdf" },
    );
  });
  assertEquals(calls, [
    ["readFile", { path: "notes/a.md", directory: "DATA", encoding: "utf8" }],
    ["readFile", { path: "img.png", directory: "CACHE" }],
    ["writeFile", {
      path: "notes/a.md",
      data: "hi",
      directory: "DATA",
      recursive: true,
      encoding: "utf8",
    }],
    ["writeFile", { path: "img.png", data: "AAEC", directory: "DOCUMENTS", recursive: false }],
    ["deleteFile", { path: "notes/a.md", directory: "DATA" }],
    ["readdir", { path: "", directory: "DATA" }],
    ["downloadFile", {
      url: "https://example.com/m.pdf",
      path: "m.pdf",
      directory: "DOCUMENTS",
      recursive: true,
    }],
  ]);
});

Deno.test("filesystem: bad paths, directories, encodings and URLs are refused up front", async () => {
  await assertRejects(() => readFile("../etc/passwd"), TypeError, "relative path");
  await assertRejects(() => writeFile("/abs", "x"), TypeError, "relative path");
  await assertRejects(
    () => readFile("a", { directory: "library" as Any }),
    TypeError,
    "unknown directory",
  );
  await assertRejects(
    () => writeFile("a", "x", { encoding: "hex" as Any }),
    TypeError,
    "unknown encoding",
  );
  await assertRejects(() => downloadToFile("file:///x", "a"), TypeError, "not an http(s) URL");
});

/** A fake OPFS tree: files hold bytes, with a size and a lastModified. */
class FakeFile {
  readonly kind = "file" as const;
  bytes: Uint8Array = new Uint8Array();
  constructor(public name: string) {}
  getFile(): Promise<Any> {
    return Promise.resolve(
      new File([this.bytes as Uint8Array<ArrayBuffer>], this.name, { lastModified: 1000 }),
    );
  }
  createWritable(): Promise<Any> {
    return Promise.resolve({
      write: (chunk: string | Uint8Array) => {
        this.bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
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
    return child.kind === "directory"
      ? Promise.resolve(child)
      : Promise.reject(new DOMException(name, "TypeMismatchError"));
  }
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<Any> {
    let child = this.children.get(name);
    if (!child && opts?.create) this.children.set(name, child = new FakeFile(name));
    if (!child) return Promise.reject(new DOMException(name, "NotFoundError"));
    return child.kind === "file"
      ? Promise.resolve(child)
      : Promise.reject(new DOMException(name, "TypeMismatchError"));
  }
  removeEntry(name: string): Promise<void> {
    return this.children.delete(name)
      ? Promise.resolve()
      : Promise.reject(new DOMException(name, "NotFoundError"));
  }
  async *entries(): AsyncGenerator<[string, FakeFile | FakeDir]> {
    for (const entry of this.children) yield entry;
  }
}

/** Run `fn` with a fresh fake OPFS as `navigator.storage`. */
function withOpfs(fn: (root: FakeDir) => Promise<void>): Promise<void> {
  const root = new FakeDir("");
  const navigator = { storage: { getDirectory: () => Promise.resolve(root) } };
  return withGlobals({ navigator }, () => fn(root));
}

Deno.test("filesystem: web OPFS fallback — directory folders, text and base64, list, delete", async () => {
  await withOpfs(async (root) => {
    await writeFile("notes/a.md", "héllo", { recursive: true });
    assertEquals(await readFile("notes/a.md"), "héllo");
    assert(root.children.has("data"), "the directory is a top-level OPFS folder");
    await writeFile("img.bin", bytesToBase64(new Uint8Array([0, 1, 255])), {
      directory: "cache",
      encoding: "base64",
    });
    assertEquals(await readFile("img.bin", { directory: "cache", encoding: "base64" }), "AAH/");
    assertEquals(await readFile("img.bin", { directory: "cache" }).then((t) => t.length), 3);
    // Without `recursive`, a missing parent folder rejects, as natively.
    await assertRejects(() => writeFile("missing/x.txt", "x"));
    assertEquals(await listDir(""), [
      { name: "notes", type: "directory", size: 0 },
    ]);
    assertEquals(await listDir("notes"), [
      { name: "a.md", type: "file", size: 6, mtime: 1000 },
    ]);
    await deleteFile("notes/a.md");
    assertEquals(await listDir("notes"), []);
    await assertRejects(() => readFile("notes/a.md"));
  });
  // No OPFS (SSR, an insecure context): a clear rejection.
  await withGlobals({ navigator: {} }, async () => {
    await assertRejects(() => readFile("a"), Error, "no filesystem here");
  });
});

Deno.test("filesystem: downloadToFile on the web fetches, then writes to OPFS", async () => {
  await withOpfs(async () => {
    const fetched: string[] = [];
    const fetch = (url: string) => {
      fetched.push(url);
      return Promise.resolve(
        url.endsWith("404") ? new Response("no", { status: 404 }) : new Response("PDF-bytes"),
      );
    };
    await withGlobals({ fetch }, async () => {
      assertEquals(await downloadToFile("https://x.test/m.pdf", "docs/m.pdf"), {
        path: "data/docs/m.pdf",
      });
      assertEquals(await readFile("docs/m.pdf"), "PDF-bytes");
      await assertRejects(() => downloadToFile("https://x.test/404", "y"), Error, "answered 404");
    });
    assertEquals(fetched, ["https://x.test/m.pdf", "https://x.test/404"]);
  });
});

Deno.test("filesystem: a shell plugin without downloadFile fetches, then writes natively", async () => {
  const { plugin, calls } = recorder(["writeFile"], { writeFile: { uri: "file:///docs/m.bin" } });
  const fetch = () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
  await inShell({ Filesystem: plugin }, async () => {
    assertEquals(await downloadToFile("https://x.test/m.bin", "m.bin"), {
      path: "file:///docs/m.bin",
    });
  }, { fetch });
  assertEquals(calls, [
    ["writeFile", { path: "m.bin", data: "AQID", directory: "DATA", recursive: true }],
  ]);
});

// ---- pickers -------------------------------------------------------------------

Deno.test("pickImage: native getPhoto options per source; a cancel is null", async () => {
  const { plugin, calls } = recorder(["getPhoto"], {
    getPhoto: { webPath: "capacitor://localhost/_capacitor_file_/p.jpg", format: "JPEG" },
  });
  await inShell({ Camera: plugin }, async () => {
    assertEquals(await pickImage({ source: "camera", quality: 80 }), {
      webPath: "capacitor://localhost/_capacitor_file_/p.jpg",
      format: "jpeg",
    });
    await pickImage({ as: "dataUrl" });
  });
  assertEquals(calls, [
    ["getPhoto", { resultType: "uri", source: "CAMERA", allowEditing: false, quality: 80 }],
    ["getPhoto", { resultType: "dataUrl", source: "PROMPT", allowEditing: false }],
  ]);
  for (
    const err of [
      pluginError("User cancelled photos app"),
      pluginError("x", "OS-PLUG-CAMR-0020"),
    ]
  ) {
    const cancelled = recorder(["getPhoto"], { getPhoto: err });
    await inShell({ Camera: cancelled.plugin }, async () => {
      assertEquals(await pickImage({ source: "photos" }), null);
    });
  }
  const denied = recorder(["getPhoto"], { getPhoto: pluginError("User denied access to camera") });
  await inShell({ Camera: denied.plugin }, async () => {
    await assertRejects(() => pickImage(), Error, "denied");
  });
  await assertRejects(() => pickImage({ source: "gallery" as Any }), TypeError, "unknown source");
});

/** A fake document whose file inputs choose `file` (or dispatch `cancel` when null). */
function fakeFileDocument(choose: () => File | null) {
  const inputs: Any[] = [];
  const doc = {
    body: { appendChild: (el: Any) => (el.attached = true) },
    createElement(tag: string) {
      const listeners = new Map<string, () => void>();
      const el: Any = {
        tag,
        type: "",
        accept: "",
        attrs: {} as Record<string, string>,
        style: {},
        files: null,
        attached: false,
        setAttribute: (k: string, v: string) => (el.attrs[k] = v),
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        remove: () => (el.attached = false),
        click() {
          const file = choose();
          queueMicrotask(() => {
            if (file) {
              el.files = [file];
              listeners.get("change")?.();
            } else listeners.get("cancel")?.();
          });
        },
      };
      inputs.push(el);
      return el;
    },
  };
  return { doc, inputs };
}

Deno.test("pickImage: web file input (capture for the camera), webPath or dataUrl; cancel is null", async () => {
  const png = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
  let next: File | null = png;
  const { doc, inputs } = fakeFileDocument(() => next);
  await withGlobals({ document: doc }, async () => {
    const byPath = await pickImage({ source: "camera" });
    assertEquals(byPath?.format, "png");
    assert(byPath?.webPath?.startsWith("blob:"), byPath?.webPath);
    URL.revokeObjectURL(byPath!.webPath!);
    assertEquals(await pickImage({ source: "photos", as: "dataUrl" }), {
      dataUrl: "data:image/png;base64,iVBORw==",
      format: "png",
    });
    next = null;
    assertEquals(await pickImage(), null);
  });
  assertEquals(inputs.map((i) => [i.type, i.accept, i.attrs.capture, i.attached]), [
    ["file", "image/*", "environment", false],
    ["file", "image/*", undefined, false],
    ["file", "image/*", undefined, false],
  ]);
  await withGlobals({ document: undefined }, async () => {
    await assertRejects(() => pickImage(), Error, "no document");
  });
});

Deno.test("pickDocument: native pickFiles (limit 1, readData), web base64; cancel is null", async () => {
  const { plugin, calls } = recorder(["pickFiles"], {
    pickFiles: {
      files: [{ name: "a.pdf", mimeType: "application/pdf", size: 3, path: "/tmp/a.pdf" }],
    },
  });
  await inShell({ FilePicker: plugin }, async () => {
    assertEquals(await pickDocument({ types: ["application/pdf"] }), {
      name: "a.pdf",
      mimeType: "application/pdf",
      size: 3,
      path: "/tmp/a.pdf",
    });
    await pickDocument({ readData: true });
  });
  assertEquals(calls, [
    ["pickFiles", { limit: 1, readData: false, types: ["application/pdf"] }],
    ["pickFiles", { limit: 1, readData: true }],
  ]);
  const withData = recorder(["pickFiles"], {
    pickFiles: { files: [{ name: "b", mimeType: "", size: 1, data: "QQ==" }] },
  });
  await inShell({ FilePicker: withData.plugin }, async () => {
    assertEquals(await pickDocument({ readData: true }), {
      name: "b",
      mimeType: "application/octet-stream",
      size: 1,
      data: "QQ==",
    });
  });
  const cancelled = recorder(["pickFiles"], { pickFiles: pluginError("pickFiles canceled.") });
  await inShell({ FilePicker: cancelled.plugin }, async () => {
    assertEquals(await pickDocument(), null);
  });

  const txt = new File(["hi"], "n.txt", { type: "text/plain" });
  let next: File | null = txt;
  const { doc, inputs } = fakeFileDocument(() => next);
  await withGlobals({ document: doc }, async () => {
    assertEquals(await pickDocument({ types: ["text/plain", "application/json"] }), {
      name: "n.txt",
      mimeType: "text/plain",
      size: 2,
      data: "aGk=",
    });
    next = null;
    assertEquals(await pickDocument(), null);
  });
  assertEquals(inputs.map((i) => [i.accept, i.attrs.capture]), [
    ["text/plain,application/json", undefined],
    ["", undefined],
  ]);
});

// ---- barcode -------------------------------------------------------------------

Deno.test("scanBarcode: native hint per format, required options, format names; cancel is null", async () => {
  const { plugin, calls } = recorder(["scanBarcode"], {
    scanBarcode: { ScanResult: "ABC-123", format: 5 },
  });
  await inShell({ CapacitorBarcodeScanner: plugin }, async () => {
    assertEquals(await scanBarcode({ formats: ["code_128"] }), {
      value: "ABC-123",
      format: "code_128",
    });
    await scanBarcode({ formats: ["qr_code", "ean_13"] });
    await scanBarcode();
  });
  const base = {
    scanInstructions: " ",
    scanButton: false,
    scanText: " ",
    cameraDirection: 1,
    scanOrientation: 3,
  };
  assertEquals(calls, [
    ["scanBarcode", { hint: 5, ...base }],
    ["scanBarcode", { hint: 17, ...base }],
    ["scanBarcode", { hint: 17, ...base }],
  ]);
  const cancelled = recorder(["scanBarcode"], {
    scanBarcode: pluginError(
      "Couldn’t scan because the process was cancelled.",
      "OS-PLUG-BARC-0006",
    ),
  });
  await inShell({ CapacitorBarcodeScanner: cancelled.plugin }, async () => {
    assertEquals(await scanBarcode(), null);
  });
  const denied = recorder(["scanBarcode"], {
    scanBarcode: pluginError("no camera", "OS-PLUG-BARC-0007"),
  });
  await inShell({ CapacitorBarcodeScanner: denied.plugin }, async () => {
    const err = await assertRejects(() => scanBarcode());
    assertEquals((err as Any).code, "denied");
  });
  await assertRejects(() => scanBarcode({ formats: ["qr" as Any] }), TypeError, "unknown format");
});

/** A fake DOM for the web scanner: elements record listeners, attachment and srcObject. */
function fakeScanDocument() {
  const made: Any[] = [];
  const body: Any = { children: [] as Any[], append: (el: Any) => body.children.push(el) };
  const doc = {
    body,
    createElement(tag: string) {
      const listeners = new Map<string, () => void>();
      const el: Any = {
        tag,
        style: {},
        setAttribute() {},
        append() {},
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        remove: () => (body.children = body.children.filter((c: Any) => c !== el)),
        play: () => Promise.resolve(),
        fire: (type: string) => listeners.get(type)?.(),
        srcObject: null,
      };
      made.push(el);
      return el;
    },
  };
  return { doc, body, made };
}

/** A camera stream whose tracks record `stop()`. */
function fakeStream() {
  const tracks = [{
    stopped: false,
    stop() {
      this.stopped = true;
    },
  }];
  return { tracks, stream: { getTracks: () => tracks } };
}

Deno.test("scanBarcode: web BarcodeDetector over the camera; the stream stops and the overlay goes", async () => {
  const { doc, body, made } = fakeScanDocument();
  const cam = fakeStream();
  const constraints: unknown[] = [];
  let detectCalls = 0;
  const created: unknown[] = [];
  class BarcodeDetector {
    constructor(opts?: unknown) {
      created.push(opts);
    }
    static getSupportedFormats() {
      return Promise.resolve(["qr_code", "ean_13"]);
    }
    detect() {
      return Promise.resolve(++detectCalls < 2 ? [] : [{ rawValue: "hello", format: "qr_code" }]);
    }
  }
  const navigator = {
    mediaDevices: {
      getUserMedia: (c: unknown) => (constraints.push(c), Promise.resolve(cam.stream)),
    },
  };
  await withGlobals({ document: doc, navigator, BarcodeDetector }, async () => {
    assertEquals(await scanBarcode({ formats: ["qr_code", "code_39"] }), {
      value: "hello",
      format: "qr_code",
    });
    await assertRejects(() => scanBarcode({ formats: ["code_39"] }), Error, "cannot read code_39");
  });
  assertEquals(created, [{ formats: ["qr_code"] }]);
  assertEquals(constraints, [{ video: { facingMode: "environment" }, audio: false }]);
  assert(cam.tracks[0].stopped, "the camera track was stopped");
  assertEquals(body.children, [], "the overlay was removed");
  assertEquals(made.find((e) => e.tag === "video").srcObject, null);
});

Deno.test("scanBarcode: web cancel resolves null and still stops the camera; unsupported / denied", async () => {
  const { doc, body, made } = fakeScanDocument();
  const cam = fakeStream();
  class BarcodeDetector {
    detect() {
      return Promise.resolve([]);
    }
  }
  const navigator = { mediaDevices: { getUserMedia: () => Promise.resolve(cam.stream) } };
  await withGlobals({ document: doc, navigator, BarcodeDetector }, async () => {
    const scan = scanBarcode();
    await new Promise((r) => setTimeout(r, 0));
    made.find((e) => e.tag === "button").fire("click");
    assertEquals(await scan, null);
  });
  assert(cam.tracks[0].stopped);
  assertEquals(body.children, []);

  // No BarcodeDetector (Safari, Firefox): unsupported.
  await withGlobals({ document: doc, navigator, BarcodeDetector: undefined }, async () => {
    const err = await assertRejects(() => scanBarcode());
    assertEquals((err as Any).code, "unsupported");
  });
  // Camera permission refused: denied, and no overlay was ever shown.
  const refusing = {
    mediaDevices: { getUserMedia: () => Promise.reject(new DOMException("no", "NotAllowedError")) },
  };
  await withGlobals({ document: doc, navigator: refusing, BarcodeDetector }, async () => {
    const err = await assertRejects(() => scanBarcode());
    assertEquals((err as Any).code, "denied");
  });
  assertEquals(body.children, []);
});

// ---- quick actions -------------------------------------------------------------

/** A fake AppShortcuts plugin whose `click` listeners can be fired; handles resolve async. */
function fakeShortcuts() {
  const { plugin, calls } = recorder(["set", "clear"]);
  const listeners = new Set<(e: unknown) => void>();
  let removed = 0;
  (plugin as Any).addListener = (_event: string, fn: (e: unknown) => void) => {
    listeners.add(fn);
    return Promise.resolve({
      remove: () => {
        removed++;
        listeners.delete(fn);
        return Promise.resolve();
      },
    });
  };
  return {
    plugin,
    calls,
    fire: (e: unknown) => [...listeners].forEach((fn) => fn(e)),
    count: () => listeners.size,
    removed: () => removed,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("setQuickActions: native set / clear with mapped fields; checks; a no-op on the web", async () => {
  const fake = fakeShortcuts();
  await inShell({ AppShortcuts: fake.plugin }, async () => {
    await setQuickActions([
      { id: "new", title: "New chat", subtitle: "Start a thread", icon: "square.and.pencil" },
      { id: "find", title: "Search", icon: { android: "ic_search" } },
    ]);
    await setQuickActions([]);
    await assertRejects(() => setQuickActions([{ id: "", title: "x" }]), TypeError, "non-empty id");
    await assertRejects(
      () => setQuickActions([{ id: "a", title: "" }]),
      TypeError,
      "non-empty title",
    );
    await assertRejects(
      () => setQuickActions([{ id: "a", title: "A" }, { id: "a", title: "B" }]),
      TypeError,
      "unique",
    );
  });
  assertEquals(fake.calls, [
    ["set", {
      shortcuts: [
        {
          id: "new",
          title: "New chat",
          description: "Start a thread",
          iosIcon: "square.and.pencil",
          androidIcon: "square.and.pencil",
        },
        { id: "find", title: "Search", androidIcon: "ic_search" },
      ],
    }],
    ["clear", undefined],
  ]);
  await setQuickActions([{ id: "a", title: "A" }]); // the web: nothing to call, no throw
});

Deno.test("onQuickAction: one shared native listener, removed with the last subscriber", async () => {
  resetQuickActionsForTesting();
  const fake = fakeShortcuts();
  await inShell({ AppShortcuts: fake.plugin }, async () => {
    const a: string[] = [];
    const b: string[] = [];
    const stopA = onQuickAction((id) => a.push(id));
    const stopB = onQuickAction((id) => b.push(id));
    await tick();
    assertEquals(fake.count(), 1, "one native listener");
    fake.fire({ shortcutId: "new" });
    fake.fire({}); // no id: ignored
    stopA();
    fake.fire({ shortcutId: "find" });
    stopB();
    await tick();
    assertEquals(a, ["new"]);
    assertEquals(b, ["new", "find"]);
    assertEquals(fake.count(), 0);
    assertEquals(fake.removed(), 1);

    // An unsubscribe before the handle arrives still removes the listener.
    const early = onQuickAction(() => {});
    early();
    await tick();
    assertEquals(fake.count(), 0);
  });
  resetQuickActionsForTesting();
  // The web: nothing to listen to.
  const stop = onQuickAction(() => assert(false));
  stop();
});

Deno.test("useQuickAction: subscribes on mount with the latest callback, unsubscribes on unmount", async () => {
  resetQuickActionsForTesting();
  const fake = fakeShortcuts();
  await inShell({ AppShortcuts: fake.plugin }, async () => {
    const { doc, container } = makeDom();
    setDocument(doc as Any);
    const seen: string[] = [];
    let label = "first";
    function Probe(_props: { n: number }) {
      useQuickAction((id) => seen.push(`${label}:${id}`));
      return null;
    }
    const root = createRoot(container as Any);
    root.render(h(Probe as Any, { n: 1 }));
    flushSync();
    await tick();
    fake.fire({ shortcutId: "new" });
    label = "second";
    root.render(h(Probe as Any, { n: 2 }));
    flushSync();
    fake.fire({ shortcutId: "find" });
    assertEquals(seen, ["first:new", "second:find"]);
    assertEquals(fake.count(), 1, "a re-render did not re-subscribe");
    root.unmount();
    flushSync();
    await tick();
    assertEquals(fake.count(), 0);
  });
  resetQuickActionsForTesting();
});
