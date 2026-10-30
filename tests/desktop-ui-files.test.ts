// src/build/desktop-ui-files.ts: where a desktop window's UI files come from. The bundled export
// is served from its folder; a signed UI overlay is served from the bytes its `read` verified
// (whole, with one `Range` honored), a request it cannot name (undecodable, a directory) is no
// file, a file it lacks is no file, and once the overlay is withdrawn everything (assets, page
// text, the preload) comes from the bundled export. The overlay here is a stand-in whose `read`
// answers what each case needs; the real one is desktop-updater.test.ts's.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { desktopUiFiles } from "../src/build/desktop-ui-files.ts";
import { DESKTOP_PRELOAD_FILE } from "../src/desktop/preload.ts";
import type { DesktopUiOverlay, DesktopUiRead } from "../src/desktop/updater.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** A bundled export with an index page, an asset and a preload, in a temp dir. */
async function bundledDir(preload = true): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_ui_files_" });
  await Deno.writeTextFile(join(dir, "index.html"), "<p>bundled</p>");
  await Deno.writeTextFile(join(dir, "app.js"), "bundled();");
  if (preload) {
    await Deno.mkdir(join(dir, "_denext"), { recursive: true });
    await Deno.writeTextFile(join(dir, DESKTOP_PRELOAD_FILE), "bundledPreload('</script>');");
  }
  return dir;
}

/** An overlay whose files are `files`; `withdrawn` answers every read as withdrawn. */
function overlay(
  files: Record<string, string>,
  state: { withdrawn: boolean; reads: string[] },
): DesktopUiOverlay {
  return {
    version: "v2",
    dir: "/nowhere",
    get withdrawn() {
      return state.withdrawn;
    },
    read(path: string): Promise<DesktopUiRead> {
      state.reads.push(path);
      if (state.withdrawn) return Promise.resolve({ status: "withdrawn" });
      const text = files[path];
      return Promise.resolve(
        text === undefined ? { status: "missing" } : { status: "ok", bytes: enc(text) },
      );
    },
  };
}

const get = (headers: HeadersInit = {}, method = "GET") =>
  new Request("http://ui.test/x", { method, headers });

Deno.test("desktopUiFiles: without an overlay, the bundled export is served from its folder", async () => {
  const dir = await bundledDir();
  try {
    const files = desktopUiFiles({ bundledDir: dir, overlay: null });
    const res = await files.asset("/app.js", undefined, get());
    assertEquals(res?.status, 200);
    assertEquals(await res!.text(), "bundled();");
    assertEquals(await files.text("/index.html"), "<p>bundled</p>");
    // A page the export lacks is no text (its response body, if any, is released).
    assertEquals(await files.text("/nope.html"), null);
    assertEquals(await files.preload(), "bundledPreload('<\\/script>');");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopUiFiles: the bundled export without a preload has none", async () => {
  const dir = await bundledDir(false);
  try {
    assertEquals(await desktopUiFiles({ bundledDir: dir, overlay: null }).preload(), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopUiFiles: an overlay's file is served whole from its verified bytes", async () => {
  const dir = await bundledDir();
  const state = { withdrawn: false, reads: [] as string[] };
  try {
    const files = desktopUiFiles({
      bundledDir: dir,
      overlay: overlay({ "app.js": "overlay();", "data.bin": "x" }, state),
    });
    const res = await files.asset("/app.js", "gzip", get());
    assertEquals(res?.status, 200);
    assertEquals(res!.headers.get("content-type"), "text/javascript; charset=UTF-8");
    assertEquals(res!.headers.get("accept-ranges"), "bytes");
    assertEquals(res!.headers.get("content-length"), "10");
    assertEquals(res!.headers.get("content-range"), null);
    assertEquals(await res!.text(), "overlay();");
    // An extension with no known type is an octet stream.
    const bin = await files.asset("/data.bin", undefined, get());
    assertEquals(bin!.headers.get("content-type"), "application/octet-stream");
    await bin!.body?.cancel();
    // The path is decoded and its leading slashes dropped before the overlay is asked.
    assertEquals(state.reads, ["app.js", "data.bin"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopUiFiles: an overlay's file honors one Range, refuses an unsatisfiable one, and HEAD has no body", async () => {
  const dir = await bundledDir();
  const state = { withdrawn: false, reads: [] as string[] };
  try {
    const files = desktopUiFiles({
      bundledDir: dir,
      overlay: overlay({ "a.txt": "0123456789" }, state),
    });
    const part = await files.asset("/a.txt", undefined, get({ range: "bytes=2-4" }));
    assertEquals(part?.status, 206);
    assertEquals(part!.headers.get("content-range"), "bytes 2-4/10");
    assertEquals(part!.headers.get("content-length"), "3");
    assertEquals(await part!.text(), "234");
    const refused = await files.asset("/a.txt", undefined, get({ range: "bytes=50-60" }));
    assertEquals(refused?.status, 416);
    assertEquals(refused!.headers.get("content-range"), "bytes */10");
    assertEquals(refused!.body, null);
    const head = await files.asset("/a.txt", undefined, get({}, "HEAD"));
    assertEquals(head?.status, 200);
    assertEquals(head!.headers.get("content-length"), "10");
    assertEquals(head!.body, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopUiFiles: a request that names no overlay file is no file, the overlay never asked", async () => {
  const dir = await bundledDir();
  const state = { withdrawn: false, reads: [] as string[] };
  try {
    const files = desktopUiFiles({ bundledDir: dir, overlay: overlay({ "app.js": "o" }, state) });
    // Undecodable, the root, a directory.
    for (const pathname of ["/%E0%A4%A", "/", "/assets/"]) {
      assertEquals(await files.asset(pathname, undefined, get()), null, pathname);
      assertEquals(await files.text(pathname), null, pathname);
    }
    assertEquals(state.reads, []);
    // A file the overlay lacks is missing: never the bundled export's file of that name.
    assertEquals(await files.asset("/index.html", undefined, get()), null);
    assertEquals(await files.text("/index.html"), null);
    assertEquals(await files.preload(), undefined);
    assertEquals(state.reads, ["index.html", "index.html", DESKTOP_PRELOAD_FILE]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopUiFiles: an overlay's page text and preload come from its verified bytes", async () => {
  const dir = await bundledDir();
  const state = { withdrawn: false, reads: [] as string[] };
  try {
    const files = desktopUiFiles({
      bundledDir: dir,
      overlay: overlay({
        "index.html": "<p>overlay</p>",
        [DESKTOP_PRELOAD_FILE]: "overlayPreload('</script>');",
      }, state),
    });
    assertEquals(await files.text("/index.html"), "<p>overlay</p>");
    // Inline-safe, as the bundled preload is.
    assertEquals(await files.preload(), "overlayPreload('<\\/script>');");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktopUiFiles: once the overlay is withdrawn, assets, pages and the preload are the bundled export's", async () => {
  const dir = await bundledDir();
  const state = { withdrawn: false, reads: [] as string[] };
  try {
    const files = desktopUiFiles({
      bundledDir: dir,
      overlay: overlay({
        "app.js": "overlay();",
        "index.html": "<p>overlay</p>",
        [DESKTOP_PRELOAD_FILE]: "overlayPreload();",
      }, state),
    });
    assertEquals(await (await files.asset("/app.js", undefined, get()))!.text(), "overlay();");
    state.withdrawn = true;
    const res = await files.asset("/app.js", undefined, get());
    assertEquals(res?.status, 200);
    assertEquals(await res!.text(), "bundled();");
    assertEquals(await files.text("/index.html"), "<p>bundled</p>");
    assertEquals(await files.preload(), "bundledPreload('<\\/script>');");
    assert(state.reads.length >= 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
