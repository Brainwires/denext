// The browser half of the "picked handle" contract: with the File System Access API,
// `pickFolder` / `pickDocument` / `saveFile` register the browser's handle in page memory and
// return an opaque `web:` id; the file functions reach it through `{ picked: id }`. Without the
// API the old fallbacks run (`unavailable`, `<input type=file>`, a download). A fake FSA tree
// stands in for Chromium's.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  deleteFile,
  downloadToFile,
  listDir,
  pickDocument,
  pickFolder,
  readFile,
  saveFile,
  writeFile,
} from "../src/mobile/mod.ts";
import { resetPickedHandlesForTesting } from "../src/mobile/picked-web.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";

/** A permission state the fake handles answer, shared by a whole tree. */
interface Perms {
  write: PermissionState;
  onRequest: PermissionState;
  requests: number;
}

/** One node of a fake File System Access tree. */
class Node {
  readonly children = new Map<string, Node>();
  text = "";
  removed = false;
  constructor(
    readonly kind: "file" | "directory",
    readonly name: string,
    readonly perms: Perms,
  ) {}

  queryPermission(d: { mode: string }): Promise<PermissionState> {
    return Promise.resolve(d.mode === "readwrite" ? this.perms.write : "granted");
  }
  requestPermission(): Promise<PermissionState> {
    this.perms.requests++;
    this.perms.write = this.perms.onRequest;
    return Promise.resolve(this.perms.write);
  }
  #child(name: string, kind: Node["kind"], create?: boolean): Promise<Node> {
    let node = this.children.get(name);
    if (!node && create) this.children.set(name, node = new Node(kind, name, this.perms));
    if (!node) return Promise.reject(new DOMException(name, "NotFoundError"));
    if (node.kind !== kind) return Promise.reject(new DOMException(name, "TypeMismatchError"));
    return Promise.resolve(node);
  }
  getDirectoryHandle(name: string, o?: { create?: boolean }) {
    return this.#child(name, "directory", o?.create);
  }
  getFileHandle(name: string, o?: { create?: boolean }) {
    return this.#child(name, "file", o?.create);
  }
  removeEntry(name: string): Promise<void> {
    return this.children.delete(name)
      ? Promise.resolve()
      : Promise.reject(new DOMException(name, "NotFoundError"));
  }
  remove(): Promise<void> {
    this.removed = true;
    return Promise.resolve();
  }
  async *entries(): AsyncGenerator<[string, Node]> {
    for (const e of this.children) yield e;
  }
  getFile(): Promise<File> {
    return Promise.resolve(new File([this.text], this.name, { type: "text/plain" }));
  }
  createWritable() {
    return Promise.resolve({
      write: (chunk: string | Blob | Uint8Array) => {
        if (typeof chunk === "string") this.text = chunk;
        else if (chunk instanceof Uint8Array) this.text = new TextDecoder().decode(chunk);
        else return chunk.text().then((t) => void (this.text = t));
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    });
  }
}

const perms = (write: PermissionState = "granted", onRequest: PermissionState = "granted") => ({
  write,
  onRequest,
  requests: 0,
});

/** Install `globals` for the duration of `fn`, restoring them after. */
async function withGlobals(
  globals: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const prev = new Map(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]));
  for (const [k, v] of Object.entries(globals)) {
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  }
  try {
    await fn();
  } finally {
    resetPickedHandlesForTesting();
    for (const [k, d] of prev) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

const abort = () => Promise.reject(new DOMException("dismissed", "AbortError"));

Deno.test("web picked: pickFolder registers the directory; read/write/list/delete through { picked }", async () => {
  const root = new Node("directory", "Projects", perms());
  const readme = await root.getFileHandle("readme.md", { create: true });
  readme.text = "hi";
  await withGlobals({ showDirectoryPicker: () => Promise.resolve(root) }, async () => {
    const folder = await pickFolder();
    assert(folder);
    assertEquals(folder.name, "Projects");
    assertEquals(folder.path, undefined);
    assert(folder.handle.startsWith("web:"), folder.handle);
    const directory = { picked: folder.handle };
    assertEquals(await readFile("readme.md", { directory }), "hi");
    await writeFile("notes/a.md", "A", { directory, recursive: true });
    await writeFile("b.bin", btoa("xyz"), { directory, encoding: "base64" });
    assertEquals(await readFile("b.bin", { directory }), "xyz");
    assertEquals((await listDir("", { directory })).map((e) => e.name), [
      "b.bin",
      "notes",
      "readme.md",
    ]);
    assertEquals((await listDir("notes", { directory })).map((e) => e.name), ["a.md"]);
    await deleteFile("notes/a.md", { directory });
    assertEquals(await listDir("notes", { directory }), []);
    // A picked folder is not a file.
    await assertRejects(() => readFile("", { directory }));
  });
});

Deno.test("web picked: writes ask for write access once; a refusal is a typed forbidden", async () => {
  const root = new Node("directory", "P", perms("prompt", "granted"));
  await withGlobals({ showDirectoryPicker: () => Promise.resolve(root) }, async () => {
    const folder = await pickFolder();
    assert(folder);
    await writeFile("a.txt", "1", { directory: { picked: folder.handle } });
    assertEquals(root.perms.requests, 1);
    await writeFile("a.txt", "2", { directory: { picked: folder.handle } });
    assertEquals(root.perms.requests, 1);
  });
  const denied = new Node("directory", "Q", perms("prompt", "denied"));
  await withGlobals({ showDirectoryPicker: () => Promise.resolve(denied) }, async () => {
    const folder = await pickFolder();
    assert(folder);
    const err = await assertRejects(() =>
      writeFile("a.txt", "1", { directory: { picked: folder.handle } })
    );
    assert(isDesktopBridgeError(err));
    assertEquals(err.code, "forbidden");
    // Reading needs no write access.
    assertEquals(await listDir("", { directory: { picked: folder.handle } }), []);
  });
});

Deno.test('web picked: pickDocument uses showOpenFilePicker; the file is read with the path ""', async () => {
  const file = new Node("file", "a.txt", perms());
  file.text = "abc";
  const seen: unknown[] = [];
  const showOpenFilePicker = (o: unknown) => {
    seen.push(o);
    return Promise.resolve([file]);
  };
  await withGlobals({ showOpenFilePicker }, async () => {
    const doc = await pickDocument({ types: ["text/plain", ".txt"] });
    assert(doc?.handle?.startsWith("web:"));
    const { handle } = doc as { handle: string };
    assertEquals(doc?.name, "a.txt");
    assertEquals(doc?.mimeType, "text/plain");
    assertEquals(doc?.data, btoa("abc"));
    assertEquals(seen, [{ multiple: false, types: [{ accept: { "text/plain": [] } }] }]);
    const directory = { picked: handle };
    assertEquals(await readFile("", { directory }), "abc");
    await assertRejects(() => readFile("x.txt", { directory }), TypeError, "takes the path");
    await assertRejects(() => listDir("", { directory }), TypeError, "not a folder");
    await deleteFile("", { directory });
    assert(file.removed);
  });
  await withGlobals({ showOpenFilePicker: abort }, async () => {
    assertEquals(await pickDocument(), null);
  });
});

Deno.test("web picked: saveFile uses showSaveFilePicker, writes, and returns a handle", async () => {
  const target = new Node("file", "export.csv", perms());
  const seen: unknown[] = [];
  const showSaveFilePicker = (o: unknown) => {
    seen.push(o);
    return Promise.resolve(target);
  };
  await withGlobals({ showSaveFilePicker }, async () => {
    const saved = await saveFile("a,b", { suggestedName: "export.csv", types: ["text/csv"] });
    assert(saved?.handle?.startsWith("web:"));
    const { handle } = saved as { handle: string };
    assertEquals(saved?.name, "export.csv");
    assertEquals(target.text, "a,b");
    assertEquals(seen, [{ suggestedName: "export.csv", types: [{ accept: { "text/csv": [] } }] }]);
    const directory = { picked: handle };
    await writeFile("", "c,d", { directory });
    assertEquals(await readFile("", { directory }), "c,d");
    // downloadToFile into a picked file (display path: the relative one).
    const fetch = () => Promise.resolve(new Response("PDF"));
    await withGlobals({ fetch }, async () => {
      assertEquals(await downloadToFile("https://x.test/a", "", { directory }), { path: "" });
    });
    assertEquals(target.text, "PDF");
  });
  await withGlobals({ showSaveFilePicker: abort }, async () => {
    assertEquals(await saveFile("x"), null);
  });
});

Deno.test("web picked: unknown handles are forbidden; no FSA keeps the old fallbacks", async () => {
  await withGlobals({}, async () => {
    for (const picked of ["web:forged", "h-1-folder"]) {
      const err = await assertRejects(() => readFile("a", { directory: { picked } }));
      assert(isDesktopBridgeError(err));
      assertEquals(err.code, "forbidden");
    }
    // No showDirectoryPicker: unavailable, as before.
    const err = await assertRejects(() => pickFolder());
    assert(isDesktopBridgeError(err));
    assertEquals(err.code, "unavailable");
  });
  // Handles do not survive a reset (a reload).
  const root = new Node("directory", "R", perms());
  await withGlobals({ showDirectoryPicker: () => Promise.resolve(root) }, async () => {
    const folder = await pickFolder();
    assert(folder);
    resetPickedHandlesForTesting();
    const err = await assertRejects(() => listDir("", { directory: { picked: folder.handle } }));
    assertStringIncludes(String(err), "forbidden");
  });
  // Inside the Capacitor shell a picked handle is unavailable.
  const Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: {} };
  await withGlobals({ Capacitor }, async () => {
    const err = await assertRejects(() => readFile("a", { directory: { picked: "h-1" } }));
    assert(isDesktopBridgeError(err));
    assertEquals(err.code, "unavailable");
  });
});
