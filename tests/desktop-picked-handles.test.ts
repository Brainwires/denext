// The page side of the "picked handle" file-access contract in a Deno Desktop window: the dialogs
// resolve `{ path, handle }` (path display-only), the file functions reach a picked item through
// `directory: { picked: handle }`, the shell functions take `{ handle }`, and a forged handle is
// a typed `forbidden`. Driven through the fake runtime (tests/helpers/desktop-fake-runtime.ts).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  deleteFile,
  downloadToFile,
  listDir,
  moveToTrash,
  openPath,
  pickDocument,
  pickFolder,
  readFile,
  revealInFileManager,
  saveFile,
  writeFile,
} from "../src/mobile/mod.ts";
import { resetDesktopBridgeForTesting } from "../src/desktop/bridge-client.ts";
import { isDesktopBridgeError } from "../src/desktop/client.ts";
import {
  createFakeDesktopRuntime,
  createFakePickedFs,
  type FakeMethod,
  type FakePickedFs,
} from "./helpers/desktop-fake-runtime.ts";

/** Run `fn` in a fake desktop window whose runtime serves `fake` (plus `extra` caps). */
async function inDesktop(
  fake: FakePickedFs,
  fn: (rt: ReturnType<typeof createFakeDesktopRuntime>) => Promise<void>,
  extra: Record<string, Record<string, FakeMethod>> = {},
  omit: ReadonlyArray<"fs" | "shell" | "dialogs"> = [],
): Promise<void> {
  const caps: Record<string, Record<string, FakeMethod>> = { ...extra };
  for (const [cap, methods] of Object.entries(fake.caps)) {
    if (!omit.includes(cap as "fs")) caps[cap] = methods;
  }
  const rt = createFakeDesktopRuntime(caps);
  const restore = rt.install();
  try {
    await fn(rt);
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
}

/** The rejection's code, asserting it is a typed bridge error. */
async function codeOf(p: () => Promise<unknown>): Promise<string> {
  const err = await assertRejects(p);
  assert(isDesktopBridgeError(err), String(err));
  return err.code;
}

Deno.test("picked: pickFolder → { path, name, handle }; the folder is read, written, listed by handle", async () => {
  const fake = createFakePickedFs({ pickFolder: "/Users/me/Projects" });
  fake.disk.set("/Users/me/Projects/readme.md", "hi");
  await inDesktop(fake, async (rt) => {
    const folder = await pickFolder();
    assert(folder);
    assertEquals(folder.path, "/Users/me/Projects");
    assertEquals(folder.name, "Projects");
    assertEquals(typeof folder.handle, "string");
    const directory = { picked: folder.handle };
    assertEquals(await readFile("readme.md", { directory }), "hi");
    await writeFile("notes/a.md", "A", { directory, recursive: true });
    assertEquals(fake.disk.get("/Users/me/Projects/notes/a.md"), "A");
    // Names only, sorted; no absolute paths reach the page.
    const listing = await listDir("", { directory });
    assertEquals(listing.map((e) => [e.name, e.type]), [
      ["notes", "directory"],
      ["readme.md", "file"],
    ]);
    assert(!JSON.stringify(listing).includes("/Users/me"));
    await deleteFile("notes/a.md", { directory });
    assertEquals(fake.disk.has("/Users/me/Projects/notes/a.md"), false);
    // The RPC carries exactly `{ picked }` as the directory (extra keys are dropped).
    await readFile("readme.md", { directory: { ...directory, path: "/etc" } as never });
    assertEquals(rt.calls.at(-1)?.args, {
      path: "readme.md",
      directory: { picked: folder.handle },
      encoding: "utf8",
    });
    // A relative `..` never reaches the runtime.
    await assertRejects(() => readFile("../x", { directory }), TypeError);
  });
});

Deno.test('picked: pickDocument → a read-only file handle, read with the path ""', async () => {
  const fake = createFakePickedFs({ openFile: "/Users/me/a.txt" });
  fake.disk.set("/Users/me/a.txt", "abc");
  await inDesktop(fake, async () => {
    const doc = await pickDocument();
    assert(doc?.handle);
    assertEquals(doc.path, "/Users/me/a.txt");
    const directory = { picked: doc.handle };
    assertEquals(await readFile("", { directory }), "abc");
    assertEquals(await readFile("", { directory, encoding: "base64" }), btoa("abc"));
    // A write through an open-panel handle is refused by the runtime.
    assertEquals(await codeOf(() => writeFile("", "x", { directory })), "forbidden");
    // A file handle takes no sub-path.
    assertEquals(await codeOf(() => readFile("b.txt", { directory })), "forbidden");
  });
});

Deno.test("picked: saveFile → a read/write handle; the shell takes { handle }", async () => {
  const fake = createFakePickedFs({ saveFile: "/Users/me/export.csv" });
  await inDesktop(fake, async (rt) => {
    const saved = await saveFile("a,b", { suggestedName: "export.csv" });
    assert(saved?.handle);
    assertEquals(saved.name, "export.csv");
    const directory = { picked: saved.handle };
    await writeFile("", "c,d", { directory });
    assertEquals(await readFile("", { directory }), "c,d");
    await openPath({ handle: saved.handle });
    await revealInFileManager({ handle: saved.handle });
    await moveToTrash({ handle: saved.handle });
    assertEquals(fake.shellTargets, [
      { action: "open", path: "/Users/me/export.csv" },
      { action: "reveal", path: "/Users/me/export.csv" },
      { action: "trash", path: "/Users/me/export.csv" },
    ]);
    // Only the handle travels: the display path is never sent as authority.
    const shellCalls = rt.calls.filter((c) => c.cap === "shell");
    assertEquals(shellCalls.map((c) => c.args), [
      { handle: saved.handle },
      { handle: saved.handle },
      { handle: saved.handle },
    ]);
    // A plain path still works (inside the app's folders).
    await openPath("/app/data/f.pdf");
    assertEquals(rt.calls.at(-1)?.args, { path: "/app/data/f.pdf" });
    await assertRejects(() => openPath({ handle: "" }), TypeError);
  });
});

Deno.test("picked: a forged or expired handle is a typed forbidden", async () => {
  const fake = createFakePickedFs();
  await inDesktop(fake, async () => {
    const directory = { picked: "forged-handle" };
    assertEquals(await codeOf(() => readFile("a.txt", { directory })), "forbidden");
    assertEquals(await codeOf(() => listDir("", { directory })), "forbidden");
    assertEquals(await codeOf(() => deleteFile("a.txt", { directory })), "forbidden");
    assertEquals(await codeOf(() => openPath({ handle: "forged-handle" })), "forbidden");
    // A page-memory (browser) handle this page never issued: forbidden without a request.
    assertEquals(
      await codeOf(() => readFile("a.txt", { directory: { picked: "web:nope" } })),
      "forbidden",
    );
  });
});

Deno.test("picked: without the fs capability a runtime handle is unavailable (no web fallback)", async () => {
  const fake = createFakePickedFs({ pickFolder: "/Users/me/P" });
  await inDesktop(
    fake,
    async () => {
      const folder = await pickFolder();
      assert(folder);
      const directory = { picked: folder.handle };
      assertEquals(await codeOf(() => readFile("a", { directory })), "unavailable");
      assertEquals(await codeOf(() => writeFile("a", "x", { directory })), "unavailable");
      assertEquals(
        await codeOf(() => downloadToFile("https://example.com/a", "a", { directory })),
        "unavailable",
      );
    },
    {},
    ["fs"],
  );
});

Deno.test("picked: cancelled dialogs resolve null; a folder answer without a handle is a bridge_error", async () => {
  await inDesktop(createFakePickedFs(), async () => {
    assertEquals(await pickFolder(), null);
    assertEquals(await pickDocument(), null);
    assertEquals(await saveFile("x"), null);
  });
  const rt = createFakeDesktopRuntime({ dialogs: { pickFolder: () => ({ path: "/x/P" }) } });
  const restore = rt.install();
  try {
    assertEquals(await codeOf(() => pickFolder()), "bridge_error");
  } finally {
    resetDesktopBridgeForTesting();
    restore();
  }
});

Deno.test("picked: the directory option is checked before any request", async () => {
  await inDesktop(createFakePickedFs(), async (rt) => {
    await assertRejects(
      () => readFile("a", { directory: { picked: "" } }),
      TypeError,
      "non-empty handle",
    );
    await assertRejects(
      () => readFile("a", { directory: { picked: 7 } as never }),
      TypeError,
      "non-empty handle",
    );
    await assertRejects(() => readFile("a", { directory: "tmp" as never }), TypeError, "unknown");
    assertEquals(rt.calls.length, 0);
  });
});
