// The desktop kitchen sink's pure harness logic (examples/desktop-kitchen-sink): the tiling
// decision its geometry checks skip on. The window test itself runs in CI's desktop-window
// workflow; these run with the unit suite.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { tiledReason } from "../examples/desktop-kitchen-sink/app/geometry.ts";

/** i3 on the Pi's 4K screen: a tiled window, under i3bar's 20 px. */
const SCREEN = {
  bounds: { width: 3840, height: 2160 },
  workArea: { width: 3840, height: 2160 },
};
const TILED = { width: 3836, height: 2116 };

Deno.test("kitchen sink geometry: an unmaximized window filling the work area is tiled (Sway)", () => {
  const reason = tiledReason("900x700", {
    maximized: false,
    fullscreen: false,
    bounds: TILED,
  }, SCREEN);
  assertStringIncludes(reason!, "asked 900x700");
  assertStringIncludes(reason!, "unmaximized");
});

Deno.test("kitchen sink geometry: i3 reads a tiled window as maximized and ignores unmaximize", () => {
  // The Pi's i3 run: maximized: true before and after unmaximizeWindow(), filling the screen.
  const reason = tiledReason(
    "640x480 (the minimum)",
    { maximized: true, fullscreen: false, bounds: TILED, contentBounds: TILED },
    SCREEN,
    { unmaximizeIgnored: true },
  );
  assert(reason, "a skip, not a failure");
  assertStringIncludes(reason, "asked 640x480 (the minimum)");
  assertStringIncludes(reason, "ignores unmaximize");
  assertStringIncludes(reason, "3836x2116");
});

Deno.test("kitchen sink geometry: real failures stay failures", () => {
  const maximized = { maximized: true, fullscreen: false, bounds: TILED };
  // A stacking window manager honoured the unmaximize: the window was merely maximized.
  assertEquals(tiledReason("900x700", maximized, SCREEN, { unmaximizeIgnored: false }), null);
  // Not asked (unknown): no guess.
  assertEquals(tiledReason("900x700", maximized, SCREEN), null);
  // Ignored, but the window does not fill the screen: not a tiled slot.
  assertEquals(
    tiledReason(
      "900x700",
      { ...maximized, bounds: { width: 1200, height: 800 } },
      SCREEN,
      { unmaximizeIgnored: true },
    ),
    null,
  );
  // Fullscreen is the app's own state, and a small window is just a failure.
  assertEquals(
    tiledReason("900x700", { maximized: false, fullscreen: true, bounds: TILED }, SCREEN),
    null,
  );
  assertEquals(
    tiledReason("900x700", {
      maximized: false,
      fullscreen: false,
      bounds: { width: 800, height: 600 },
    }, SCREEN),
    null,
  );
  assertEquals(tiledReason("900x700", { maximized: false, fullscreen: false }, SCREEN), null);
});

// --- the window test's flags and results document -------------------------------------------

import {
  parseWindowTestArgs,
  resultsDocument,
  runtimeOf,
} from "../examples/desktop-kitchen-sink/e2e/window-test.ts";
import { parseFlags } from "../examples/desktop-kitchen-sink/e2e/cli-args.ts";
import pin from "../src/build/desktop-runtime-pin.json" with { type: "json" };

Deno.test("kitchen sink window test: flags for the backend, the runtime and the results", () => {
  const none = parseWindowTestArgs([]);
  assertEquals(none, {
    noPackage: false,
    noUpdate: false,
    noSigning: false,
    backend: null,
    runtimeDir: null,
    stockRuntime: false,
    results: null,
    json: false,
  });
  assertEquals(runtimeOf(none), { mode: "pinned", version: pin.version, dir: null });
  const all = parseWindowTestArgs([
    "--no-package",
    "--backend",
    "cef",
    "--runtime-dir=/opt/runtime",
    "--json",
    "--results",
    "out.json",
  ]);
  assertEquals(
    [all.noPackage, all.backend, all.runtimeDir, all.json, all.results],
    [true, "cef", "/opt/runtime", true, "out.json"],
  );
  assertEquals(runtimeOf(all), { mode: "local", version: null, dir: "/opt/runtime" });
  assertEquals(runtimeOf(parseWindowTestArgs(["--stock-runtime"])).mode, "stock");
  // A boolean flag never swallows the next argument.
  assertEquals(parseWindowTestArgs(["--json", "--backend", "webview"]).backend, "webview");
  const refused = (args: string[]) => {
    try {
      parseWindowTestArgs(args);
    } catch (err) {
      return (err as Error).message;
    }
    return "accepted";
  };
  assertStringIncludes(refused(["--backend", "gtk"]), "webview or cef");
  assertStringIncludes(refused(["--nope"]), "unknown flag --nope");
  assertStringIncludes(refused(["--results"]), "--results needs a value");
  assertStringIncludes(refused(["--runtime-dir", "/x", "--stock-runtime"]), "choose one");
  assertStringIncludes(refused(["stray"]), "unexpected argument stray");
});

Deno.test("kitchen sink window test: the results document carries counts, facts and the runtime", () => {
  const options = parseWindowTestArgs(["--backend", "cef"]);
  const facts = { platformFeatures: { available: true, features: { sessionType: "x11" } } };
  const doc = resultsDocument(
    { backend: "cef", runtime: runtimeOf(options), options, facts },
    [
      { phase: "main", name: "a", status: "pass", detail: "ok", ms: 1 },
      { phase: "main", name: "b", status: "skip", detail: "tiled", ms: 2 },
      { phase: "main", name: "c", status: "fail", detail: "no", ms: 3 },
    ],
    ["c: no"],
  );
  assertEquals(doc.schema, 1);
  assertEquals(doc.backend, "cef");
  assertEquals(doc.ok, false);
  assertEquals(doc.summary, { pass: 1, skip: 1, fail: 1, problems: 1 });
  assertEquals(doc.facts, facts);
  assertEquals((doc.runtime as { version: string }).version, pin.version);
  // The shape the CI summary (scripts/ci/desktop-window-summary.ts) reads is unchanged.
  assertEquals((doc.results as unknown[]).length, 3);
  assertEquals(doc.problems, ["c: no"]);
});

Deno.test("kitchen sink: flag parsing for the command-line tools", () => {
  assertEquals(parseFlags(["maximize", "--timeout", "500", "--dir=/d", "--json"]), {
    positional: ["maximize"],
    flags: { timeout: "500", dir: "/d", json: "" },
  });
  // A JSON argument is positional, not a flag.
  assertEquals(parseFlags(["size", '{"width":800}']).positional, ["size", '{"width":800}']);
});

// --- the drive mode's queue protocol ---------------------------------------------------------

import {
  DRIVE_COMMANDS,
  isDriveId,
  nextQueueFile,
  parseDriveCommand,
  queueFileName,
} from "../examples/desktop-kitchen-sink/app/drive/protocol.ts";

Deno.test("kitchen sink drive mode: queue files are taken oldest first, half-written ones never", () => {
  const a = queueFileName(1_000, 0, "first");
  const b = queueFileName(1_000, 1, "second");
  const c = queueFileName(20_000, 0, "third");
  assertEquals(nextQueueFile([c, b, a]), a);
  assertEquals(nextQueueFile([c, b]), b, "the sequence orders one millisecond's commands");
  assertEquals(nextQueueFile([`${a}.tmp`, c]), c, "a .tmp file is still being written");
  assertEquals(nextQueueFile([]), null);
  assert(isDriveId("c1-abc"));
  for (const bad of ["", "../x", "UPPER", "a/b", "x".repeat(65), 7]) assert(!isDriveId(bad));
  let threw = false;
  try {
    queueFileName(1, 0, "../escape");
  } catch {
    threw = true;
  }
  assert(threw, "an id that is not a plain name never becomes a file name");
});

Deno.test("kitchen sink drive mode: a command file is checked, and a bad one still gets an answer", () => {
  const name = queueFileName(5, 0, "c1");
  assertEquals(parseDriveCommand('{"id":"c1","cmd":"maximize"}', name), {
    command: { id: "c1", cmd: "maximize" },
  });
  assertEquals(parseDriveCommand('{"id":"c1","cmd":"size","args":{"width":800}}', name), {
    command: { id: "c1", cmd: "size", args: { width: 800 } },
  });
  // The id comes from the file name when the content can't give one, so the driver is answered.
  assertEquals(parseDriveCommand("{not json", name), {
    id: "c1",
    error: "the command file is not JSON",
  });
  assertEquals(parseDriveCommand('{"id":"../x","cmd":""}', name), { id: "c1", error: "no cmd" });
  assertEquals(parseDriveCommand('{"cmd":"size","args":3}', name), {
    id: "c1",
    error: "args must be an object",
  });
  // Every manual check the drive mode stands in for has a command.
  for (
    const cmd of [
      "open-dialog",
      "native-dialog",
      "notify",
      "secure",
      "tray-on",
      "titlebar",
      "maximize",
      "deeplinks",
      "probe",
    ]
  ) assert(cmd in DRIVE_COMMANDS, cmd);
});
