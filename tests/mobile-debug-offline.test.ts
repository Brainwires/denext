// On-device debugging and the offline screen: `denext mobile inspect` (steps + best-effort opening
// of Safari / chrome://inspect through an injected runner), `denext mobile dev` turning WebView
// debugging on for its session only (and a killed session's native copies scrubbed of it),
// `denext mobile add offline-screen` (public/offline.html + server.errorPath) and the
// `installOfflineScreen` overlay in denext/mobile.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { type InspectRunner, inspectSteps, openInspector } from "../src/build/mobile-inspect.ts";
import {
  enableSessionWebDebugging,
  restoreCapacitorConfig,
  withDevServerUrl,
} from "../src/build/mobile-dev.ts";
import {
  addOfflineScreenToProject,
  OFFLINE_PAGE_HTML,
} from "../src/build/mobile-offline-screen.ts";
import { installOfflineScreen } from "../src/mobile/offline-screen.ts";

/** A runner that records calls and answers from `answers` (by command), else code 0. */
function fakeRunner(answers: Record<string, { code: number; stdout: string } | Error> = {}) {
  const calls: string[] = [];
  const run: InspectRunner = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const answer = answers[cmd];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? { code: 0, stdout: "" });
  };
  return { run, calls };
}

Deno.test("inspect: steps per platform, with the app's name and the release caveat", () => {
  const ios = inspectSteps("ios", "Receipts").join("\n");
  assertStringIncludes(ios, "Settings → Apps → Safari → Advanced → Web Inspector");
  assertStringIncludes(ios, "open Receipts");
  assertStringIncludes(ios, "ios.webContentsDebuggingEnabled");
  assert(!ios.includes("chrome://inspect"));
  const android = inspectSteps("android").join("\n");
  assertStringIncludes(android, "chrome://inspect/#devices");
  assertStringIncludes(android, "USB debugging");
  assert(!android.includes("Safari"));
  const both = inspectSteps("all").join("\n");
  assertStringIncludes(both, "Safari");
  assertStringIncludes(both, "chrome://inspect");
  assertStringIncludes(both, "denext_dev_logs");
});

Deno.test("inspect on macOS opens Safari and Chrome, and reports adb's devices", async () => {
  const { run, calls } = fakeRunner({
    adb: {
      code: 0,
      stdout: "List of devices attached\nemulator-5554\tdevice\nR58M\tunauthorized\n\n",
    },
  });
  const lines = await openInspector("all", run, "darwin");
  assertEquals(calls, [
    "open -a Safari",
    "adb devices",
    "open -a Google Chrome chrome://inspect/#devices",
  ]);
  assertStringIncludes(lines.join("\n"), "opened Safari");
  assertStringIncludes(lines.join("\n"), "adb sees emulator-5554");
  assertStringIncludes(lines.join("\n"), "R58M unauthorized");
  assertStringIncludes(lines.join("\n"), "opened chrome://inspect/#devices");
});

Deno.test("inspect elsewhere: no Safari off macOS; a missing adb or Chrome is a note", async () => {
  const { run, calls } = fakeRunner({
    adb: new Error("not found"),
    "google-chrome": { code: 1, stdout: "" },
  });
  const lines = (await openInspector("all", run, "linux")).join("\n");
  assertStringIncludes(lines, "needs a Mac; skipped");
  assertStringIncludes(lines, "adb is not on the PATH");
  assertStringIncludes(lines, "open chrome://inspect/#devices in Chrome yourself");
  assertEquals(calls, ["adb devices", "google-chrome chrome://inspect/#devices"]);
  assertEquals(await openInspector("ios", fakeRunner().run, "windows"), [
    "  iOS: Safari's Web Inspector needs a Mac; skipped.",
  ]);
});

Deno.test("mobile dev turns WebView debugging on in the native copies only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_debug_" });
  const ios = join(dir, "ios/App/App/capacitor.config.json");
  const android = join(dir, "android/app/src/main/assets/capacitor.config.json");
  try {
    // The source config is left as committed (so the native fingerprint is unchanged).
    const source = `const config = { appId: "a", webDir: "out" };\nexport default config;\n`;
    const edited = await withDevServerUrl("capacitor.config.ts", source, "http://192.168.1.5:3000");
    assert(!edited.includes("webContentsDebuggingEnabled"));
    await Deno.mkdir(join(ios, ".."), { recursive: true });
    await Deno.writeTextFile(
      ios,
      JSON.stringify({ appId: "a", ios: { scheme: "App" } }, null, "\t") + "\n",
    );
    assertEquals(await enableSessionWebDebugging(dir), ["ios/App/App/capacitor.config.json"]);
    assertEquals(JSON.parse(await Deno.readTextFile(ios)).ios, {
      scheme: "App",
      webContentsDebuggingEnabled: true,
    });
    assertStringIncludes(await Deno.readTextFile(ios), '\n\t"ios"');
    assertEquals(await enableSessionWebDebugging(dir), []);
    await Deno.mkdir(join(android, ".."), { recursive: true });
    await Deno.writeTextFile(android, "{}");
    assertEquals(await enableSessionWebDebugging(dir), [
      "android/app/src/main/assets/capacitor.config.json",
    ]);
    assertEquals(JSON.parse(await Deno.readTextFile(android)), {
      android: { webContentsDebuggingEnabled: true },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a killed session's native copies lose the dev server and the debugging flag", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_dev_scrub_" });
  const copy = join(dir, "ios/App/App/capacitor.config.json");
  const android = join(dir, "android/app/src/main/assets/capacitor.config.json");
  try {
    await Deno.mkdir(join(copy, ".."), { recursive: true });
    await Deno.mkdir(join(android, ".."), { recursive: true });
    await Deno.writeTextFile(
      copy,
      JSON.stringify(
        {
          appId: "a",
          server: { url: "http://192.168.1.5:3000", cleartext: true },
          ios: { webContentsDebuggingEnabled: true, scheme: "App" },
        },
        null,
        2,
      ) + "\n",
    );
    // A release config with its own flag and no dev server is left alone.
    const own = JSON.stringify({ appId: "a", android: { webContentsDebuggingEnabled: true } }) +
      "\n";
    await Deno.writeTextFile(android, own);
    await restoreCapacitorConfig(dir);
    assertEquals(JSON.parse(await Deno.readTextFile(copy)), { appId: "a", ios: { scheme: "App" } });
    assertEquals(await Deno.readTextFile(android), own);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mobile add offline-screen writes offline.html and server.errorPath; idempotent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_offline_" });
  try {
    await Deno.writeTextFile(join(dir, "denext.config.ts"), "export default {};\n");
    await Deno.writeTextFile(
      join(dir, "capacitor.config.ts"),
      `const config = { appId: "a", webDir: "out" };\nexport default config;\n`,
    );
    const report = await addOfflineScreenToProject({ dir });
    assertEquals(report.written, ["public/offline.html", "capacitor.config.ts"]);
    assertEquals(report.manual, []);
    const page = await Deno.readTextFile(join(dir, "public/offline.html"));
    assert(page.startsWith("<!-- denext-offline-screen-template: 1 sha256="));
    assert(page.endsWith(OFFLINE_PAGE_HTML));
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "capacitor.config.ts")),
      'errorPath: "offline.html"',
    );
    const again = await addOfflineScreenToProject({ dir });
    assertEquals(again.written, []);
    assertEquals(again.unchanged, ["public/offline.html", "capacitor.config.ts"]);
    // An edited page is kept; --force replaces it.
    await Deno.writeTextFile(join(dir, "public/offline.html"), page.replace("offline", "OFFLINE"));
    const kept = await addOfflineScreenToProject({ dir });
    assertEquals(kept.kept, ["public/offline.html"]);
    const forced = await addOfflineScreenToProject({ dir, force: true });
    assertEquals(forced.written, ["public/offline.html"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("offline-screen keeps an errorPath the config already has", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_offline_" });
  try {
    await Deno.writeTextFile(
      join(dir, "capacitor.config.json"),
      JSON.stringify({ appId: "a", server: { errorPath: "error.html" } }),
    );
    const report = await addOfflineScreenToProject({ dir });
    assertEquals(report.written, ["public/offline.html"]);
    assert(report.manual.some((m) => m.includes("already sets server.errorPath")));
    assert(report.manual.some((m) => m.includes("no denext.config here")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A minimal DOM for the overlay: elements with children, attributes and listeners. */
class El {
  id = "";
  type = "";
  textContent = "";
  children: El[] = [];
  parent: El | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, f: () => void) {
    this.listeners[k] = f;
  }
  append(...nodes: El[]) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
}

Deno.test("installOfflineScreen shows the overlay while offline and removes it online", () => {
  const g = globalThis as Record<string, unknown>;
  const body = new El("body");
  const doc = {
    body,
    createElement: (tag: string) => new El(tag),
    getElementById: (id: string) => body.children.find((c) => c.id === id) ?? null,
  };
  const listeners: Record<string, () => void> = {};
  const nav = globalThis.navigator as unknown as { onLine?: boolean };
  const prior = { document: g.document, add: g.addEventListener, remove: g.removeEventListener };
  const onLine = Object.getOwnPropertyDescriptor(nav, "onLine");
  let online = false;
  Object.defineProperty(nav, "onLine", { get: () => online, configurable: true });
  g.document = doc;
  g.addEventListener = (k: string, f: () => void) => void (listeners[k] = f);
  g.removeEventListener = (k: string) => void delete listeners[k];
  try {
    const dispose = installOfflineScreen({ title: "Offline!" });
    assertEquals(body.children.length, 1);
    const overlay = body.children[0];
    assertEquals(overlay.id, "denext-offline-screen");
    assertEquals(overlay.attrs.role, "alertdialog");
    assertEquals(overlay.children[1].children[0].textContent, "Offline!");
    online = true;
    listeners.online();
    assertEquals(body.children.length, 0);
    online = false;
    listeners.offline();
    assertEquals(body.children.length, 1);
    dispose();
    assertEquals(body.children.length, 0);
    assertEquals(Object.keys(listeners), []);
  } finally {
    g.document = prior.document;
    g.addEventListener = prior.add;
    g.removeEventListener = prior.remove;
    if (onLine) Object.defineProperty(nav, "onLine", onLine);
    else delete (nav as Record<string, unknown>).onLine;
  }
});

Deno.test("installOfflineScreen is a no-op without a DOM", () => {
  assertEquals(typeof (globalThis as Record<string, unknown>).document, "undefined");
  installOfflineScreen()();
});
