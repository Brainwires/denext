// The capabilities that use denext's pinned Deno Desktop runtime's own APIs when it has them:
// `clipboard` (Deno.desktop.clipboard: text, HTML, PNG images) and `dialogs` (Deno.desktop.dialog:
// the OS's own panels, with the page's MIME types as filters) — each driven against a fake
// `Deno.desktop`, plus the stock-runtime behaviour (clipboard `unavailable`, dialogs falling back
// to the dialog programs).

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { clipboardCapability } from "../src/desktop/caps/clipboard.ts";
import { dialogFilters, dialogsCapability } from "../src/desktop/caps/dialogs.ts";
import { type DesktopCapCtx, DesktopCapError } from "../src/desktop/extension.ts";
import type {
  DesktopAppApi,
  DesktopDialogOptions,
  DesktopNativeClipboard,
} from "../src/desktop/launch-events.ts";
import { PickedPaths } from "../src/desktop/picked-paths.ts";

const ctx = (window?: unknown): DesktopCapCtx => ({
  emit: () => {},
  appSupportDir: "",
  runOnMainThread: () => Promise.reject(new Error("no UI thread in tests")),
  os: "darwin",
  signal: new AbortController().signal,
  ...(window !== undefined ? { window } : {}),
});

// deno-lint-ignore no-explicit-any
const call = (cap: { methods: Record<string, any> }, method: string, args: unknown, c = ctx()) =>
  Promise.resolve().then(() => cap.methods[method].handler(args, c));

// --- clipboard ---------------------------------------------------------------------------

/** A fake native clipboard holding one kind of content at a time, like the OS. */
function fakeClipboard(caps = { text: true, html: true, image: true, formats: true }) {
  const state: { text: string; html: string; image: Uint8Array | null } = {
    text: "",
    html: "",
    image: null,
  };
  const writes: string[] = [];
  const clip: DesktopNativeClipboard = {
    capabilities: () => caps,
    readText: () => Promise.resolve(state.text),
    writeText: (t) => {
      writes.push(`text:${t}`);
      Object.assign(state, { text: t, html: "", image: null });
      return Promise.resolve();
    },
    readHTML: () => Promise.resolve(state.html),
    writeHTML: (h, t) => {
      writes.push(`html:${h}|${t ?? ""}`);
      Object.assign(state, { html: h, text: t ?? "", image: null });
      return Promise.resolve();
    },
    readImage: () => Promise.resolve(state.image),
    writeImage: (png) => {
      if (png[0] !== 0x89) return Promise.reject(new TypeError("not a PNG"));
      writes.push(`image:${png.length}`);
      Object.assign(state, { image: png, text: "", html: "" });
      return Promise.resolve();
    },
    availableFormats: () =>
      Promise.resolve([
        ...(state.text ? ["text/plain"] : []),
        ...(state.html ? ["text/html"] : []),
        ...(state.image ? ["image/png"] : []),
      ]),
  };
  return { clip, state, writes, api: { clipboard: clip } as DesktopAppApi };
}

Deno.test("clipboard: text, HTML and images through Deno.desktop.clipboard", async () => {
  const { api, writes, state } = fakeClipboard();
  const cap = clipboardCapability({ api });
  assertEquals(await call(cap, "capabilities", {}), { text: true, html: true, image: true });
  await call(cap, "writeText", { text: "plain" });
  assertEquals(await call(cap, "readText", {}), "plain");
  await call(cap, "write", { html: "<b>hi</b>", text: "hi" });
  assertEquals(await call(cap, "read", { format: "html" }), "<b>hi</b>");
  assertEquals(await call(cap, "read", {}), "hi");
  assertEquals(await call(cap, "formats", {}), ["text/plain", "text/html"]);
  const png = btoa("\x89PNG\r\n");
  await call(cap, "write", { image: png });
  assertEquals(state.image?.length, 6);
  assertEquals(await call(cap, "read", { format: "image" }), png);
  assertEquals(await call(cap, "formats", {}), ["image/png"]);
  await call(cap, "write", { text: "again" });
  assertEquals(await call(cap, "read", { format: "image" }), "", "no image: empty");
  assertEquals(writes, ["text:plain", "html:<b>hi</b>|hi", "image:6", "text:again"]);
});

Deno.test("clipboard: bad writes are validation errors; a non-PNG image is refused", async () => {
  const { api } = fakeClipboard();
  const cap = clipboardCapability({ api });
  for (
    const args of [
      {},
      { image: btoa("\x89PNG"), text: "x" },
      { html: 42 },
      { text: "x".repeat(4 * 1024 * 1024 + 1) },
      { image: btoa("GIF89a") },
      { image: "!!not base64!!" },
    ]
  ) {
    const err = await assertRejects(() => call(cap, "write", args), DesktopCapError);
    assertEquals(err.code, "validation", JSON.stringify(args).slice(0, 40));
  }
  const err = await assertRejects(() => call(cap, "read", { format: "rtf" }), DesktopCapError);
  assertEquals(err.code, "validation");
});

Deno.test("clipboard: a backend without HTML / images answers unsupported (page falls back)", async () => {
  const { api } = fakeClipboard({ text: true, html: false, image: false, formats: true });
  const cap = clipboardCapability({ api });
  for (
    const [method, args] of [
      ["read", { format: "html" }],
      ["read", { format: "image" }],
      ["write", { html: "<i>x</i>" }],
      ["write", { image: btoa("\x89PNG") }],
    ] as const
  ) {
    const err = await assertRejects(() => call(cap, method, args), DesktopCapError);
    assertEquals(err.code, "unsupported");
    assertEquals(err.status, 501);
  }
  // Text still works.
  await call(cap, "write", { text: "ok" });
  assertEquals(await call(cap, "read", { format: "text" }), "ok");
});

Deno.test("clipboard: the stock runtime (no Deno.desktop.clipboard) answers unavailable", async () => {
  const cap = clipboardCapability({ api: {} });
  for (const method of ["readText", "writeText", "read", "write", "formats", "capabilities"]) {
    const err = await assertRejects(() => call(cap, method, { text: "x" }), DesktopCapError);
    assertEquals(err.code, "unavailable", method);
  }
});

// --- dialogs: the native path ------------------------------------------------------------

/** A fake `Deno.desktop.dialog` that records its options and answers `answer`. */
function fakeDialogs(answer: { open?: string[] | null; save?: string | null } = {}) {
  const seen: Array<{ kind: string; options: DesktopDialogOptions }> = [];
  const api: DesktopAppApi = {
    windowCapabilities: () => ({ fileDialogs: true }),
    dialog: {
      showOpenDialog: (options = {}) => {
        seen.push({ kind: "open", options });
        return Promise.resolve(answer.open ?? null);
      },
      showSaveDialog: (options = {}) => {
        seen.push({ kind: "save", options });
        return Promise.resolve(answer.save ?? null);
      },
    },
  };
  return { api, seen };
}

/** A runner that fails the test if a dialog program is spawned. */
const noPrograms = () => Promise.reject(new Error("a dialog program was spawned"));

Deno.test("dialogs (native): open / save / folder use Deno.desktop.dialog, modal to the window", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-native-dialogs-" });
  try {
    const file = join(dir, "in.pdf");
    await Deno.writeTextFile(file, "%PDF");
    const out = join(dir, "out.csv");
    const picked = new PickedPaths();
    const win = { windowId: 1 };
    const { api, seen } = fakeDialogs({ open: [file], save: out });
    const cap = dialogsCapability({ picked, api, run: noPrograms });
    const opened = await call(cap, "openFile", {
      readData: true,
      types: ["application/pdf"],
    }, ctx(win)) as { files: Array<Record<string, unknown>> };
    assertEquals(opened.files[0].name, "in.pdf");
    assertEquals(opened.files[0].data, btoa("%PDF"));
    assertEquals(
      (await picked.resolve(opened.files[0].handle, "", false)).target,
      await Deno.realPath(file),
    );
    assertEquals(seen[0].options, {
      window: win,
      filters: [{ name: "Supported files", extensions: ["pdf"] }],
      properties: ["openFile"],
    });
    const saved = await call(cap, "saveFile", {
      data: "a,b",
      suggestedName: "../-report.csv",
      types: ["text/csv"],
    }, ctx(win)) as { path: string; handle: string };
    assertEquals(await Deno.readTextFile(out), "a,b");
    assertEquals(saved.path, out);
    assertEquals(seen[1].options.defaultPath, "report.csv", "sanitized: no dir, no leading dash");
    assertEquals((await picked.resolve(saved.handle, "", true)).target, await Deno.realPath(out));
    const { api: folderApi, seen: folderSeen } = fakeDialogs({ open: [dir] });
    const folderCap = dialogsCapability({ picked, api: folderApi, run: noPrograms });
    const f = await call(folderCap, "pickFolder", {}) as { handle: string };
    assertEquals(folderSeen[0].options, { properties: ["openDirectory"] });
    assertEquals((await picked.resolve(f.handle, "", true)).root, await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dialogs (native): cancel keeps the mobile contract; busy and failures are errors", async () => {
  const picked = new PickedPaths();
  const { api } = fakeDialogs({ open: null, save: null });
  const cap = dialogsCapability({ picked, api, run: noPrograms });
  assertEquals(await call(cap, "openFile", {}), { files: [] });
  assertEquals(await call(cap, "saveFile", { data: "x" }), null);
  assertEquals(await call(cap, "pickFolder", {}), null);
  assertEquals(picked.size, 0);
  const busy = Object.assign(new Error("Another file dialog is open"), { name: "Busy" });
  const busyApi: DesktopAppApi = {
    dialog: {
      showOpenDialog: () => Promise.reject(busy),
      showSaveDialog: () => Promise.reject(new Error("The file dialog could not be shown")),
    },
  };
  const busyCap = dialogsCapability({ picked, api: busyApi, run: noPrograms });
  const e1 = await assertRejects(() => call(busyCap, "pickFolder", {}), DesktopCapError);
  assertEquals([e1.code, e1.status], ["busy", 409]);
  const e2 = await assertRejects(() => call(busyCap, "saveFile", { data: "x" }), DesktopCapError);
  assertEquals(e2.code, "dialog_failed");
});

Deno.test("dialogs: no native dialogs (stock runtime, or fileDialogs false) → the dialog programs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext-dialogs-fallback-" });
  try {
    for (
      const api of [
        {} as DesktopAppApi,
        { ...fakeDialogs().api, windowCapabilities: () => ({ fileDialogs: false }) },
        null,
      ]
    ) {
      const spawned: string[] = [];
      const cap = dialogsCapability({
        picked: new PickedPaths(),
        os: "darwin",
        api,
        run: (cmd) => {
          spawned.push(cmd);
          return Promise.resolve({ code: 0, stdout: dir });
        },
      });
      await call(cap, "pickFolder", {});
      assertEquals(spawned, ["osascript"]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dialogFilters: MIME types and .ext become one filter; unknown types mean any file", () => {
  assertEquals(dialogFilters(undefined), undefined);
  assertEquals(dialogFilters([]), undefined);
  assertEquals(dialogFilters(["application/pdf", ".CSV"]), [
    { name: "Supported files", extensions: ["pdf", "csv"] },
  ]);
  const images = dialogFilters(["image/*"])![0].extensions;
  assert(images.includes("png") && images.includes("heic"));
  // A type with no known extension must not hide the file the page asked for.
  assertEquals(dialogFilters(["application/x-made-up"]), undefined);
  assertEquals(dialogFilters(["*/*"]), undefined);
  assertEquals(dialogFilters(["application/pdf", 7]), undefined);
  assertEquals(dialogFilters([".a b"]), undefined);
});
