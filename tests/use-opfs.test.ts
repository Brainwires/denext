// OPFS hooks (src/utils/use-opfs.ts) + the File System Observer primitive
// (src/utils/use-file-system-observer.ts). Neither OPFS nor FileSystemObserver
// exists in Deno, so a fake in-memory OPFS tree + a fake FileSystemObserver are
// installed on globalThis (the wake-lock test pattern), and the client
// reconciler drives the hooks directly.

import { assert, assertEquals } from "@std/assert";
import { createRoot, flushSync, setDocument } from "../src/client/reconciler.ts";
import { h } from "../src/jsx/jsx-runtime.ts";
import {
  fileSystemObserverSupported,
  useFileSystemObserver,
} from "../src/utils/use-file-system-observer.ts";
import { type DirectoryEntry, useDirectory, useFile, useOPFSRoot } from "../src/utils/use-opfs.ts";
import { makeDom } from "./helpers/dom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// ---- a fake OPFS tree ------------------------------------------------------

class FakeFile {
  readonly kind = "file" as const;
  constructor(public name: string, public contents = "") {}
  getFile(): Promise<Any> {
    return Promise.resolve({
      text: () => Promise.resolve(this.contents),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(this.contents).buffer),
    });
  }
  createWritable(): Promise<Any> {
    return Promise.resolve({
      write: (chunk: Any) => {
        this.contents = typeof chunk === "string" ? chunk : String(chunk);
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
    if (!child) {
      if (!opts?.create) return Promise.reject(new DOMException(name, "NotFoundError"));
      child = new FakeDir(name);
      this.children.set(name, child);
    }
    if (child.kind !== "directory") return Promise.reject(new Error("not a directory"));
    return Promise.resolve(child);
  }

  getFileHandle(name: string, opts?: { create?: boolean }): Promise<Any> {
    let child = this.children.get(name);
    if (!child) {
      if (!opts?.create) return Promise.reject(new DOMException(name, "NotFoundError"));
      child = new FakeFile(name);
      this.children.set(name, child);
    }
    if (child.kind !== "file") return Promise.reject(new Error("not a file"));
    return Promise.resolve(child);
  }

  removeEntry(name: string): Promise<void> {
    if (!this.children.delete(name)) {
      return Promise.reject(new DOMException(name, "NotFoundError"));
    }
    return Promise.resolve();
  }

  async *entries(): AsyncGenerator<[string, FakeFile | FakeDir]> {
    for (const [name, handle] of this.children) yield [name, handle];
  }
  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

// ---- a fake FileSystemObserver ---------------------------------------------

const observers: FakeObserver[] = [];

class FakeObserver {
  observed: { handle: Any; opts?: Any }[] = [];
  disconnected = false;
  constructor(public cb: (records: Any[]) => void) {
    observers.push(this);
  }
  observe(handle: Any, opts?: Any): Promise<void> {
    this.observed.push({ handle, opts });
    return Promise.resolve();
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

/** Fire a change batch to every live observer. */
function fireChange(records: Any[] = [{ type: "modified" }]): void {
  for (const o of observers) if (!o.disconnected) o.cb(records);
}

// ---- persistent browser-like environment -----------------------------------

const g = globalThis as Any;
let opfsRoot = new FakeDir("");

Object.defineProperty(g.navigator, "storage", {
  configurable: true,
  value: { getDirectory: () => Promise.resolve(opfsRoot) },
});

function installObserver() {
  g.FileSystemObserver = FakeObserver;
}
installObserver();

/** Reset the shared OPFS tree + observer registry before a test. */
function reset(): FakeDir {
  opfsRoot = new FakeDir("");
  Object.defineProperty(g.navigator, "storage", {
    configurable: true,
    value: { getDirectory: () => Promise.resolve(opfsRoot) },
  });
  observers.length = 0;
  installObserver();
  return opfsRoot;
}

/** Mount `View` and return an unmount fn. */
function mount(View: () => Any): () => void {
  const { doc, container } = makeDom();
  setDocument(doc as Any);
  const root = createRoot(container as Any);
  root.render(h(View, null));
  flushSync();
  return () => {
    root.unmount();
    flushSync();
  };
}

/** Let queued microtasks + timers run, flushing committed state each round. */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
}

// ---- useFileSystemObserver -------------------------------------------------

Deno.test("useFileSystemObserver: subscribes on mount, disconnects on unmount", async () => {
  reset();
  const handle = new FakeFile("a.txt");
  const ref: { r?: ReturnType<typeof useFileSystemObserver> } = {};
  const unmount = mount(function Probe() {
    ref.r = useFileSystemObserver(handle as Any, () => {});
    return h("i", null, "x");
  });
  await flush();

  assertEquals(ref.r!.isSupported, true);
  assertEquals(observers.length, 1, "one observer created");
  assertEquals(observers[0].observed[0].handle, handle, "observed the given handle");
  assertEquals(observers[0].disconnected, false);

  unmount();
  assertEquals(observers[0].disconnected, true, "disconnected on unmount");
});

Deno.test("useFileSystemObserver: unsupported → no observer, no throw", async () => {
  reset();
  delete g.FileSystemObserver;
  try {
    const ref: { r?: ReturnType<typeof useFileSystemObserver> } = {};
    const unmount = mount(function Probe() {
      ref.r = useFileSystemObserver(new FakeFile("a") as Any, () => {});
      return h("i", null, "x");
    });
    await flush();
    assertEquals(fileSystemObserverSupported(), false);
    assertEquals(ref.r!.isSupported, false);
    assertEquals(observers.length, 0, "no observer constructed when unsupported");
    unmount();
  } finally {
    installObserver();
  }
});

// ---- useOPFSRoot -----------------------------------------------------------

Deno.test("useOPFSRoot: resolves the root directory handle", async () => {
  const root = reset();
  const ref: { r?: ReturnType<typeof useOPFSRoot> } = {};
  const unmount = mount(function Probe() {
    ref.r = useOPFSRoot();
    return h("i", null, "x");
  });
  await flush();
  assertEquals(ref.r!.isSupported, true);
  assertEquals(ref.r!.root, root as Any, "root handle resolved");
  assertEquals(ref.r!.error, null);
  unmount();
});

// ---- useDirectory ----------------------------------------------------------

Deno.test("useDirectory: lists entries sorted, and refreshes on a change record", async () => {
  const root = reset();
  const docs = new FakeDir("docs");
  docs.children.set("b.txt", new FakeFile("b.txt"));
  docs.children.set("a.txt", new FakeFile("a.txt"));
  root.children.set("docs", docs);

  const ref: { r?: ReturnType<typeof useDirectory> } = {};
  const unmount = mount(function Probe() {
    ref.r = useDirectory("docs");
    return h("i", null, "x");
  });
  await flush();

  const names = (e: DirectoryEntry[]) => e.map((x) => x.name);
  assertEquals(names(ref.r!.entries), ["a.txt", "b.txt"], "sorted by name");
  assertEquals(ref.r!.loading, false);
  assertEquals(ref.r!.error, null);

  // Mutate the underlying tree, then signal a change: the listing re-reads.
  docs.children.set("c.txt", new FakeFile("c.txt"));
  fireChange();
  await flush();
  assertEquals(names(ref.r!.entries), ["a.txt", "b.txt", "c.txt"], "auto-refreshed");

  unmount();
});

// ---- useFile ---------------------------------------------------------------

Deno.test("useFile: reads json, writes, and removes", async () => {
  const root = reset();
  const notes = new FakeDir("notes");
  notes.children.set("todo.json", new FakeFile("todo.json", '{"x":1}'));
  root.children.set("notes", notes);

  const ref: { r?: ReturnType<typeof useFile<{ x: number }>> } = {};
  const unmount = mount(function Probe() {
    ref.r = useFile<{ x: number }>("notes/todo.json", { as: "json" });
    return h("i", null, "x");
  });
  await flush();
  assertEquals(ref.r!.data, { x: 1 }, "parsed json read");
  assertEquals(ref.r!.error, null);

  await ref.r!.write('{"x":2}');
  await flush();
  assertEquals(ref.r!.data, { x: 2 }, "re-read after write");

  await ref.r!.remove();
  await flush();
  assertEquals(notes.children.has("todo.json"), false, "file removed from tree");
  assertEquals(ref.r!.data, null, "data cleared after remove");

  unmount();
});

Deno.test("useFile: reads text and creates on write when missing", async () => {
  const root = reset();

  const ref: { r?: ReturnType<typeof useFile> } = {};
  const unmount = mount(function Probe() {
    ref.r = useFile("logs/app.log", { create: true });
    return h("i", null, "x");
  });
  await flush();
  // create:true → file exists (empty) after resolve.
  assertEquals(ref.r!.data, "", "empty text file");

  await ref.r!.write("hello");
  await flush();
  assertEquals(ref.r!.data, "hello", "text re-read after write");
  const logs = root.children.get("logs") as FakeDir;
  assert(logs?.children.has("app.log"), "nested file created under new dir");

  unmount();
});
