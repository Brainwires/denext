// The desktop kitchen sink's pure harness logic (examples/desktop-kitchen-sink): the tiling
// decision its geometry checks skip on. The window test itself runs in CI's desktop-window
// workflow; these run with the unit suite.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
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
  encodePowerShell,
  parseWindowTestArgs,
  privateLanAddress,
  resultsDocument,
  runtimeOf,
  saveDialogKeys,
  windowsDialogButtonScript,
} from "../examples/desktop-kitchen-sink/e2e/window-test.ts";
import {
  ATTACHMENT_NAME,
  ATTACHMENT_TEXT,
  attachmentResponse,
} from "../examples/desktop-kitchen-sink/app/downloads.ts";
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

Deno.test("kitchen sink window test: downloadToFile's host is a private address, never loopback", () => {
  const nic = (address: string, family: "IPv4" | "IPv6" = "IPv4") => ({ family, address });
  assertEquals(
    privateLanAddress([nic("127.0.0.1"), nic("fe80::1", "IPv6"), nic("10.1.0.4")]),
    "10.1.0.4",
  );
  assertEquals(privateLanAddress([nic("172.20.3.9"), nic("192.168.1.2")]), "172.20.3.9");
  assertEquals(privateLanAddress([nic("192.168.64.3")]), "192.168.64.3");
  // Loopback, link-local, public and the edges of 172.16/12 are not offered.
  assertEquals(
    privateLanAddress([
      nic("127.0.0.1"),
      nic("169.254.10.1"),
      nic("8.8.8.8"),
      nic("172.15.0.1"),
      nic("172.32.0.1"),
      nic("fd00::1", "IPv6"),
    ]),
    null,
  );
});

Deno.test("kitchen sink window test: a save dialog is answered with Return, dismissed with Escape", () => {
  assertEquals(saveDialogKeys("linux"), {
    driver: "xdotool",
    accept: ["xdotool", "key", "--clearmodifiers", "Return"],
    dismiss: ["xdotool", "key", "--clearmodifiers", "Escape"],
  });
  const mac = saveDialogKeys("darwin")!;
  assertEquals(mac.driver, "osascript");
  assertStringIncludes(mac.accept.join(" "), "key code 36"); // Return
  assertStringIncludes(mac.dismiss.join(" "), "key code 53"); // Escape
  // Windows: the dialog's own Save / Cancel button through UI Automation, which needs no focus.
  const win = saveDialogKeys("windows", "KitchenSink-x64")!;
  assertEquals(win.driver, "uia");
  const decode = (cmd: readonly string[]) => {
    assertEquals(cmd.slice(0, 4), [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    const bytes = Uint8Array.from(atob(cmd[4]), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-16le").decode(bytes);
  };
  assertEquals(decode(win.accept), windowsDialogButtonScript("KitchenSink-x64", "1", 8));
  assertEquals(decode(win.dismiss), windowsDialogButtonScript("KitchenSink-x64", "2", 2));
  assertEquals(saveDialogKeys("freebsd"), null);
});

Deno.test("kitchen sink window test: the Windows dialog script names the app's process and the button", () => {
  const script = windowsDialogButtonScript("KitchenSink-x64", "1", 8);
  assertStringIncludes(script, "Get-Process -Name 'KitchenSink-x64'");
  assertStringIncludes(script, "AddSeconds(8)");
  // No progress records: stderr carries the reason, not PowerShell's CLIXML progress stream.
  assertStringIncludes(script, "$ProgressPreference = 'SilentlyContinue'");
  // The Common Item Dialog's Save is a descendant (a button or a split button), found by its
  // AutomationId, else by its name, and pressed through its InvokePattern.
  assertStringIncludes(script, "TreeScope]::Descendants");
  assertStringIncludes(script, "$Type::SplitButton");
  assertStringIncludes(script, "$_.Current.AutomationId -eq '1'");
  assertStringIncludes(script, "$names = @('Save', '&Save')");
  assertStringIncludes(script, "InvokePattern");
  // Else (a localized or unexposed button) the dialog's default command, by WM_COMMAND.
  assertStringIncludes(script, "SendMessage($hwnd, 0x400"); // DM_GETDEFID
  assertStringIncludes(script, "PostMessage($hwnd, 0x111"); // WM_COMMAND
  const cancel = windowsDialogButtonScript("KitchenSink-x64", "2", 2);
  assertStringIncludes(cancel, "$_.Current.AutomationId -eq '2'");
  assertStringIncludes(cancel, "$names = @('Cancel')");
  assertStringIncludes(cancel, "$command = 2"); // IDCANCEL
  assert(!cancel.includes("0x400"), "Cancel never asks for the default button");
  // The name is spliced into the script: anything but a plain process name is refused.
  assertThrows(() => windowsDialogButtonScript("x'; Remove-Item C:\\ #", "1", 8));
  // Non-ASCII survives the UTF-16LE encoding.
  const text = "Write-Output 'ü€'";
  const bytes = Uint8Array.from(atob(encodePowerShell(text)), (c) => c.charCodeAt(0));
  assertEquals(new TextDecoder("utf-16le").decode(bytes), text);
});

Deno.test("kitchen sink: the app origin's attachment is a download with the name the check expects", async () => {
  const res = attachmentResponse();
  assertEquals(
    res.headers.get("content-disposition"),
    `attachment; filename="${ATTACHMENT_NAME}"`,
  );
  assertEquals(await res.text(), ATTACHMENT_TEXT);
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

import { refocusMain } from "../examples/desktop-kitchen-sink/app/refocus.ts";

Deno.test("kitchen sink: after a secondary window closes, the main window is refocused and awaited", async () => {
  let focused = false;
  let asked = 0;
  const waited = await refocusMain({
    focus: () => {
      asked++;
      // The window manager grants the focus a little later, as xfwm4 does.
      setTimeout(() => (focused = true), 30);
      return Promise.resolve();
    },
    hasFocus: () => focused,
    timeoutMs: 2000,
    pollMs: 5,
  });
  assertEquals(asked, 1, "focus asked once");
  assertEquals(waited, true, "reports the focus came back");
});

Deno.test("kitchen sink: a window manager that never refocuses is reported, never thrown", async () => {
  let asked = 0;
  const waited = await refocusMain({
    focus: () => {
      asked++;
      return Promise.reject(new Error("unsupported"));
    },
    hasFocus: () => false,
    timeoutMs: 50,
    pollMs: 5,
  });
  assert(asked >= 1);
  assertEquals(waited, false);
});

Deno.test("kitchen sink: an already focused main window is not asked again", async () => {
  let asked = 0;
  const waited = await refocusMain({
    focus: () => {
      asked++;
      return Promise.resolve();
    },
    hasFocus: () => true,
    timeoutMs: 50,
  });
  assertEquals(asked, 0);
  assertEquals(waited, true);
});

// --- the hooks phase: the backend hooks in the real window ------------------------------------

import {
  callerRefusal,
  createHookLog,
  createQuitGuard,
  HOOKS_CHECK_NAMES,
  mainFrameMustBeVerified,
  navigationGuard,
  QUIT_BOX,
  QUIT_BOX_ANSWER_AFTER_MS,
  QUIT_GUARD_DEADLINE_MS,
  SECOND_FLAG,
  secondInstanceRecorder,
  secondLaunchesWith,
  windowMenuRecorder,
  withHooksMenu,
} from "../examples/desktop-kitchen-sink/desktop/hooks.ts";
import {
  HOOKS_PHASE_CHECKS,
  hooksEarlyExitProblem,
  messageBoxKeys,
} from "../examples/desktop-kitchen-sink/e2e/window-test.ts";

Deno.test("kitchen sink hooks: the Window menu is added to the hooks launch's config only, unmutated", () => {
  const config = { desktop: { app: { identifier: "x" }, menu: { menus: [] } }, other: 1 };
  const hooked = withHooksMenu(config);
  assertEquals((hooked.desktop as Record<string, unknown>).menu, {
    window: { items: [{ id: "kitchen-window-item", label: "Kitchen window item" }] },
  });
  assertEquals(hooked.desktop.app, { identifier: "x" });
  assertEquals(hooked.other, 1);
  assertEquals(config.desktop.menu, { menus: [] }, "the original config is untouched");
});

Deno.test("kitchen sink hooks: menu clicks and second launches are recorded per source", () => {
  const log = createHookLog();
  windowMenuRecorder(log, "runDesktop")("kitchen-window-item", { keyWindow: { id: "main" } });
  windowMenuRecorder(log, "host")("kitchen-window-item", { keyWindow: null });
  assertEquals(log.menu, [
    { source: "runDesktop", id: "kitchen-window-item", keyWindow: { id: "main" } },
    { source: "host", id: "kitchen-window-item", keyWindow: null },
  ]);
  const opened = secondInstanceRecorder(log, "runDesktop")({
    args: [`${SECOND_FLAG}=abc`, "kitchensink-link://x"],
    cwd: "/work",
  });
  assertEquals(opened, undefined, "the second launch opens no window");
  secondInstanceRecorder(log, "host")({ args: ["other"], cwd: "/work" });
  assertEquals(secondLaunchesWith(log, "abc").map((r) => r.source), ["runDesktop"]);
  assertEquals(secondLaunchesWith(log, "zzz"), []);
});

Deno.test("kitchen sink hooks: the navigation guard refuses only the armed URL and records all", () => {
  const log = createHookLog();
  const nav = navigationGuard(log);
  const event = (url: string) => {
    const e = { url, window: "main", kind: "script", prevented: false, preventDefault() {} };
    e.preventDefault = () => void (e.prevented = true);
    nav.handler(e);
    return e.prevented;
  };
  assertEquals(event("http://127.0.0.1:1/x"), false, "nothing armed");
  nav.arm("http://127.0.0.1:1/kitchen-navigate-refused");
  assertEquals(event("http://127.0.0.1:1/kitchen-navigate-refused"), true);
  assertEquals(event("http://127.0.0.1:1/other"), false);
  assertEquals(log.navigation.map((n) => n.prevented), [false, true, false]);
});

Deno.test("kitchen sink hooks: an unarmed quit goes through; an armed one asks the box once", async () => {
  const log = createHookLog();
  let clock = 0;
  const asked: unknown[] = [];
  let requested = 0;
  const guard = createQuitGuard(log, {
    confirm: (options) => {
      asked.push(options);
      clock += QUIT_BOX_ANSWER_AFTER_MS;
      return Promise.resolve(0); // Stay
    },
    requestAnswer: () => void requested++,
    now: () => clock,
  });
  assertEquals(guard.guard(), true, "unarmed: the quit goes on, no box");
  assertEquals(asked.length, 0);
  guard.arm();
  assertEquals(await guard.guard(), false, "Stay keeps the app running");
  assertEquals(requested, 1, "the runner is asked to answer before the box opens");
  assertEquals(asked, [{ ...QUIT_BOX, window: "main" }]);
  assertEquals(log.quit, {
    answer: 0,
    boxMs: QUIT_BOX_ANSWER_AFTER_MS,
    allowed: false,
    error: null,
  });
  assert(QUIT_BOX_ANSWER_AFTER_MS > QUIT_GUARD_DEADLINE_MS, "the answer comes past the deadline");
  assertEquals(guard.guard(), true, "one armed quit only");
  // Return / Escape both land on Stay: the default and the cancel button are button 0.
  assertEquals([QUIT_BOX.buttons[0], QUIT_BOX.defaultId, QUIT_BOX.cancelId], ["Stay", 0, 0]);
});

Deno.test("kitchen sink hooks: a box that cannot open keeps the app running and says why", async () => {
  const log = createHookLog();
  const guard = createQuitGuard(log, {
    confirm: () => Promise.reject(Object.assign(new Error("no boxes"), { code: "unsupported" })),
    requestAnswer: () => {},
  });
  guard.arm();
  assertEquals(await guard.guard(), false);
  assertEquals(log.quit?.error, "unsupported: no boxes");
  const quits = createQuitGuard(log, {
    confirm: () => Promise.resolve(1),
    requestAnswer: () => {},
  });
  quits.arm();
  assertEquals(await quits.guard(), true, "Quit lets it go");
});

Deno.test("kitchen sink hooks: a sub-frame's or unknown frame's call is refused, the main frame's not", () => {
  assertEquals(callerRefusal({ frame: { kind: "main", verified: false } }), null);
  assertStringIncludes(
    callerRefusal({ frame: { kind: "sub", verified: true } })!,
    "sub frame (verified by the runtime)",
  );
  assertStringIncludes(
    callerRefusal({ frame: { kind: "unknown", verified: false } })!,
    "reported by the page",
  );
  assertEquals(mainFrameMustBeVerified(true, "darwin", "webview"), true);
  assertEquals(mainFrameMustBeVerified(true, "linux", "cef"), true);
  assertEquals(mainFrameMustBeVerified(true, "windows", "webview"), false);
  assertEquals(mainFrameMustBeVerified(false, "darwin", "cef"), false);
});

Deno.test("kitchen sink hooks: the runner expects exactly the page's hooks checks", () => {
  assertEquals(HOOKS_PHASE_CHECKS, HOOKS_CHECK_NAMES);
  assertEquals(HOOKS_CHECK_NAMES.length, 6);
});

Deno.test("kitchen sink hooks: the quit box is answered with Return, or its Stay button on Windows", () => {
  assertEquals(messageBoxKeys("linux"), ["xdotool", "key", "--clearmodifiers", "Return"]);
  assertStringIncludes(messageBoxKeys("darwin")!.join(" "), "key code 36");
  const win = messageBoxKeys("windows", "KitchenSink-x64")!;
  const bytes = Uint8Array.from(atob(win[4]), (c) => c.charCodeAt(0));
  const script = new TextDecoder("utf-16le").decode(bytes);
  assertEquals(script, windowsDialogButtonScript("KitchenSink-x64", "2", 8, ["Stay"]));
  assertStringIncludes(script, "$names = @('Stay')");
  assertStringIncludes(script, "$command = 2"); // IDCANCEL: a cancelled box resolves Stay too
  assertEquals(messageBoxKeys("freebsd"), null);
  assertThrows(() => windowsDialogButtonScript("KitchenSink", "2", 8, ["St'ay"]));
});

Deno.test("kitchen sink hooks: an app that quits before reporting names the check it was in", () => {
  assertStringIncludes(
    hooksEarlyExitProblem(`6 ${HOOKS_CHECK_NAMES[5]}`, 0),
    "the 5 s guard deadline cut the host.confirm box off",
  );
  assertStringIncludes(hooksEarlyExitProblem(`1 ${HOOKS_CHECK_NAMES[0]}`, 1), HOOKS_CHECK_NAMES[0]);
  assertStringIncludes(hooksEarlyExitProblem("", null), "before its first check");
});
