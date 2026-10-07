// `denext desktop doctor`: the pinned runtime's status, and on Linux the session facts read over
// D-Bus (`busctl --user`, else `gdbus`) with a fix for each missing piece. Driven by a fake
// subprocess runner: no D-Bus, no download.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type DesktopDoctorReport,
  type DoctorRunner,
  formatDesktopDoctor,
  probeLinuxSession,
  runDesktopDoctor,
  sessionTypeOf,
} from "../src/build/desktop-doctor.ts";
import type { DesktopRuntimePin, DesktopRuntimeStatus } from "../src/build/desktop-runtime.ts";
import { desktopDoctor } from "../src/cli/commands/desktop-doctor.ts";
import type { CommandContext } from "../src/cli/command.ts";
import { join } from "@std/path";
import { capture, stubExit } from "./_cli-coverage-helpers.ts";

/** A full answer: an exit code with its stdout / stderr. */
type Answer = { code: number; stdout?: string; stderr?: string };

/**
 * A runner answering from `answers` (`"cmd arg…"` → stdout, a code, or a full answer), recording
 * each call.
 */
function fakeRun(answers: Record<string, string | number | null | Answer>, calls: string[] = []) {
  const run: DoctorRunner = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    const hit = Object.entries(answers).find(([k]) => key === k || key.startsWith(`${k} `));
    if (!hit) {
      // Unlisted: an installed tool that failed (code 1), unless the tool is listed as missing.
      return Promise.resolve(answers[cmd] === null ? null : { code: 1, stdout: "" });
    }
    const v = hit[1];
    if (v === null) return Promise.resolve(null);
    if (typeof v === "object") return Promise.resolve({ stdout: "", ...v });
    return Promise.resolve(
      typeof v === "number" ? { code: v, stdout: "" } : { code: 0, stdout: v },
    );
  };
  return run;
}

const env = (vars: Record<string, string>) => (k: string) => vars[k];

const BUSCTL_LIST = "busctl --user --no-pager --no-legend list";
const PROP = "busctl --user --timeout=5 get-property";
const LOCKED = `${PROP} org.freedesktop.secrets /org/freedesktop/secrets/aliases/default ` +
  "org.freedesktop.Secret.Collection Locked";
const portalProp = (iface: string) =>
  `${PROP} org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop ` +
  `org.freedesktop.portal.${iface} version`;
/** The portal's host app registry, introspected (xdg-desktop-portal 1.19+). */
const REGISTRY = "busctl --user --timeout=5 introspect org.freedesktop.portal.Desktop " +
  "/org/freedesktop/portal/desktop org.freedesktop.host.portal.Registry";
const REGISTRY_ANSWER = "NAME TYPE SIGNATURE RESULT/VALUE FLAGS\n.Register method sa{sv} - -\n";
/** The linker cache, read for libsecret (which the runtime loads for the secure store). */
const LDCONFIG = "/sbin/ldconfig -p";
const LIBSECRET = "\tlibsecret-1.so.0 (libc6,x86-64) => /lib/x86_64-linux-gnu/libsecret-1.so.0\n";
const NO_LIBSECRET = "\tlibc.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libc.so.6\n";
/** The sandbox probe: a user namespace with a nested one, as Chromium checks. */
const UNSHARE = "unshare --user --map-root-user unshare --user true";
const APPARMOR = "cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns";

/** A Plasma-like session: everything present. */
const FULL = {
  [BUSCTL_LIST]: [
    ":1.0 1 systemd nightness :1.0 user@1000.service - -",
    "org.freedesktop.DBus 1 systemd nightness - user@1000.service - -",
    "org.kde.StatusNotifierWatcher 900 kded6 nightness :1.9 session-2.scope 2 -",
    "org.freedesktop.secrets 901 ksecretd nightness :1.10 session-2.scope 2 -",
    "org.freedesktop.Notifications 902 plasmashell nightness :1.11 session-2.scope 2 -",
    "org.freedesktop.portal.Desktop - - - (activatable) - -",
    "org.freedesktop.systemd1 1 systemd nightness :1.1 user@1000.service - -",
    "org.kde.plasmashell 902 plasmashell nightness :1.11 session-2.scope 2 -",
  ].join("\n"),
  [REGISTRY]: REGISTRY_ANSWER,
  [LOCKED]: "b false",
  [portalProp("Notification")]: "u 2",
  [portalProp("FileChooser")]: "u 4",
  [portalProp("GlobalShortcuts")]: "u 1",
  [portalProp("Settings")]: "u 2",
  [LDCONFIG]: LIBSECRET,
  [UNSHARE]: 0,
};

const status = (over: Partial<DesktopRuntimeStatus> = {}): DesktopRuntimeStatus => ({
  mode: "pinned",
  version: "2.9.7-denext.10",
  target: "x86_64-unknown-linux-gnu",
  backend: "webview",
  cache: "cached",
  deno: { found: "2.9.7", required: "2.9.7" },
  ok: true,
  detail: "runtime 2.9.7-denext.10 for x86_64-unknown-linux-gnu/webview; cached + verified",
  ...over,
});

const pin = (
  laufeyApiVersion: number,
  version = "2.9.7-denext.11",
) => ({ laufeyApiVersion, version } as unknown as DesktopRuntimePin);

Deno.test("desktop doctor: a complete Plasma session over busctl has no findings", async () => {
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" }),
    run: fakeRun(FULL),
    pin: pin(45),
  });
  assertEquals(report.findings, []);
  assertEquals(report.runtime.platformFeatures, true);
  assertEquals(report.linux, {
    sessionType: "wayland",
    desktopHint: "KDE",
    probe: "busctl",
    libsecret: true,
    sandbox: { mode: "namespace", reason: "unprivileged user namespaces work" },
    sessionBus: true,
    trayHost: true,
    secretService: "available",
    notifications: true,
    notificationReason: null,
    portal: true,
    portalAnswered: true,
    portalVersions: { Notification: 2, FileChooser: 4, GlobalShortcuts: 1, Settings: 2 },
    portalRegistry: true,
    systemdUser: true,
    launcherBadges: true,
  });
  assertEquals(report.runtime.linuxNotifications, true);
  const text = formatDesktopDoctor(report);
  assertStringIncludes(text, "All checks passed.");
  assertStringIncludes(text, "FileChooser v4");
  assertStringIncludes(text, "✔ tray-host");
});

Deno.test("desktop doctor: stock GNOME — no tray host, a locked keyring, no libsecret, no shortcuts portal", async () => {
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
    }),
    isSocket: (path) => path === "/run/user/1000/wayland-0",
    run: fakeRun({
      [BUSCTL_LIST]: [
        "org.freedesktop.secrets 901 gnome-keyring-d nightness :1.10 session-2.scope 2 -",
        "org.freedesktop.Notifications 902 gnome-shell nightness :1.11 session-2.scope 2 -",
        "org.freedesktop.portal.Desktop 903 xdg-desktop-por nightness :1.12 - 2 -",
        "org.freedesktop.systemd1 1 systemd nightness :1.1 user@1000.service - -",
      ].join("\n"),
      [REGISTRY]: REGISTRY_ANSWER,
      [LOCKED]: "b true",
      [portalProp("FileChooser")]: "u 4",
      [LDCONFIG]: NO_LIBSECRET,
    }),
    pin: pin(45),
  });
  assertEquals(report.linux?.sessionType, "wayland", "the Wayland socket is there");
  assertEquals(report.findings.map((f) => `${f.level}:${f.check}`), [
    "warning:tray-host",
    "warning:secret-service",
    "warning:libsecret",
    "warning:portal",
    "warning:badge",
  ]);
  const tray = report.findings[0];
  assertStringIncludes(tray.fix, "gnome-extensions enable");
  assertStringIncludes(report.findings[1].message, "--password-store=basic");
  assertStringIncludes(report.findings[2].fix, "libsecret-1-0");
  assertStringIncludes(report.findings[2].message, "libsecret-1.so.0");
  assertStringIncludes(report.findings[3].message, "GlobalShortcuts");
  const text = formatDesktopDoctor(report);
  assertStringIncludes(text, "! tray-host");
  assertStringIncludes(report.findings[4].message, '"(N) " prefix');
  assertStringIncludes(report.findings[4].fix, "Dash to Dock");
  assertStringIncludes(text, "0 error(s), 5 warning(s).");
  assertStringIncludes(text, '"(N) " title prefix');
});

Deno.test("desktop doctor: gdbus when busctl is missing; activatable / absent services; no portal", async () => {
  const calls: string[] = [];
  const gdbus = "gdbus call --session --timeout 5";
  const facts = await probeLinuxSession(
    fakeRun({
      busctl: null,
      [`${gdbus} --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames`]:
        "(['org.freedesktop.DBus', ':1.4', 'org.kde.StatusNotifierWatcher'],)",
      [`${gdbus} --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListActivatableNames`]:
        "(['org.freedesktop.secrets', 'org.freedesktop.Notifications'],)",
      // The activatable notification server starts, as the runtime starts it on first use.
      [`${gdbus} --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.StartServiceByName org.freedesktop.Notifications 0`]:
        "(uint32 1,)",
    }, calls),
    env({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }),
  );
  assertEquals(facts.probe, "gdbus");
  assertEquals(facts.sessionType, "x11");
  assertEquals(facts.trayHost, true);
  assertEquals(facts.secretService, "activatable", "installed, not running: never started here");
  assertEquals(facts.notifications, true);
  assertEquals([facts.portal, facts.portalVersions], [false, {}]);
  assert(!calls.some((c) => c.includes("org.freedesktop.secrets /")), "the store is not woken");
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }),
    run: fakeRun({
      [BUSCTL_LIST]: "org.kde.StatusNotifierWatcher 1 x y - - - -",
    }),
    pin: pin(45),
  });
  assertEquals(report.linux?.secretService, "absent");
  assertEquals(report.findings.map((f) => f.check), [
    "secret-service",
    "notifications",
    "portal",
    "scheduled-notifications",
    "badge",
  ]);
  assertStringIncludes(report.findings[2].fix, "xdg-desktop-portal");
});

Deno.test("desktop doctor: gdbus properties, a missing default keyring, a FileChooser-less portal", async () => {
  const gdbus = "gdbus call --session --timeout 5";
  const get = (dest: string, path: string, iface: string, prop: string) =>
    `${gdbus} --dest ${dest} --object-path ${path} --method org.freedesktop.DBus.Properties.Get ${iface} ${prop}`;
  const facts = await probeLinuxSession(
    fakeRun({
      busctl: null,
      [`${gdbus} --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames`]:
        "(['org.freedesktop.secrets', 'org.freedesktop.portal.Desktop'],)",
      [`${gdbus} --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListActivatableNames`]:
        1,
      [
        get(
          "org.freedesktop.portal.Desktop",
          "/org/freedesktop/portal/desktop",
          "org.freedesktop.portal.Settings",
          "version",
        )
      ]: "(<uint32 2>,)",
    }),
    env({ XDG_SESSION_TYPE: "x11" }),
  );
  assertEquals(facts.secretService, "locked", "no default collection reads as locked");
  assertEquals(facts.portalVersions, { Settings: 2 });
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "x11" }),
    run: fakeRun({
      [BUSCTL_LIST]: [
        "org.kde.StatusNotifierWatcher 1 a b - - - -",
        "org.freedesktop.Notifications 1 a b - - - -",
        "org.freedesktop.portal.Desktop 1 a b - - - -",
        "org.freedesktop.secrets 1 a b - - - -",
        "org.freedesktop.systemd1 1 a b - - - -",
        "com.canonical.Unity 1 a b - - - -",
      ].join("\n"),
      [REGISTRY]: REGISTRY_ANSWER,
      [LOCKED]: "b false",
    }),
    pin: pin(45),
  });
  assertEquals(report.findings.map((f) => f.message), ["the portal has no FileChooser backend"]);
});

Deno.test("desktop doctor: no session bus is an error; no bus tools and a tty are warnings", async () => {
  const noBus = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "tty" }),
    run: fakeRun({ [BUSCTL_LIST]: 1, gdbus: null }),
    pin: pin(45),
  });
  assertEquals(noBus.linux?.secretService, "no-session-bus");
  assertEquals(noBus.linux?.probe, "busctl");
  assertEquals(noBus.findings.map((f) => `${f.level}:${f.check}`), [
    "warning:session",
    "error:session-bus",
  ]);
  assertStringIncludes(formatDesktopDoctor(noBus), "✖ session-bus");
  const noTools = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({}),
    run: fakeRun({ busctl: null, gdbus: null }),
    pin: pin(45),
  });
  assertEquals(noTools.linux?.probe, null);
  assertEquals(noTools.linux?.sessionType, "unknown");
  assertEquals(noTools.findings.map((f) => f.check), ["session", "session-bus"]);
});

Deno.test("desktop doctor: the runtime — deno mismatch, a pre-probe pin, stock, unpinned, invalid cache", async () => {
  const run = fakeRun(FULL);
  const linux = { os: "linux", env: env({ XDG_SESSION_TYPE: "x11" }), run };
  const checksOf = (r: DesktopDoctorReport) => r.findings.map((f) => `${f.level}:${f.check}`);
  const old = await runDesktopDoctor({
    ...linux,
    runtimeStatus: () => Promise.resolve(status({ deno: { found: "2.9.6", required: "2.9.7" } })),
    pin: pin(44),
  });
  assertEquals(old.runtime.platformFeatures, false);
  assertEquals(checksOf(old), ["error:runtime", "warning:runtime"]);
  assertStringIncludes(old.findings[0].message, "needs Deno 2.9.7 exactly");
  assertStringIncludes(old.findings[1].message, "predates Deno.desktop.platformFeatures()");
  assertStringIncludes(old.findings[0].fix, "deno upgrade --version 2.9.7");
  // Off Linux the pre-probe pin is not a finding (the facts only matter there).
  const mac = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "darwin",
    pin: pin(44),
  });
  assertEquals([mac.linux, mac.findings, mac.checks], [null, [], ["runtime"]]);
  assertStringIncludes(formatDesktopDoctor(mac), "not in this runtime");
  const stock = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status({ mode: "stock", backend: null, cache: "n/a" })),
    os: "darwin",
    pin: pin(45),
  });
  assertEquals(checksOf(stock), ["warning:runtime"]);
  assertStringIncludes(stock.findings[0].message, "DENEXT_DESKTOP_RUNTIME=stock");
  const unpinned = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status({ cache: "unpinned" })),
    os: "darwin",
    pin: pin(45),
  });
  assertEquals(checksOf(unpinned), ["error:runtime"]);
  assertStringIncludes(unpinned.findings[0].message, "no pinned runtime build");
  const invalid = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status({ cache: "invalid" })),
    os: "darwin",
    pin: pin(45),
  });
  assertEquals(invalid.findings.map((f) => f.level), ["warning"]);
  const badBackend = await runDesktopDoctor({
    runtimeStatus: () =>
      Promise.resolve(status({ backend: null, cache: "unpinned", detail: "bad backend" })),
    os: "darwin",
    pin: pin(45),
  });
  assertEquals(badBackend.findings.length, 1, "unpinned wins over a null backend");
  const noBackend = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status({ backend: null, detail: "desktop.backend is x" })),
    os: "darwin",
    pin: pin(45),
  });
  assertEquals(noBackend.findings.map((f) => f.message), ["desktop.backend is x"]);
});

Deno.test("desktop doctor: notification clicks, scheduled notifications and the badge (runtime 2.9.7-denext.11)", async () => {
  // Sway on an older xdg-desktop-portal, no systemd user manager, no dock.
  const sway = {
    [BUSCTL_LIST]: [
      "org.kde.StatusNotifierWatcher 1 waybar nightness - - - -",
      "org.freedesktop.Notifications 1 mako nightness - - - -",
      "org.freedesktop.portal.Desktop 1 xdg-desktop-por nightness - - - -",
      "org.freedesktop.secrets 1 gnome-keyring-d nightness - - - -",
    ].join("\n"),
    [REGISTRY]: 1,
    [LOCKED]: "b false",
    [portalProp("FileChooser")]: "u 4",
    [portalProp("GlobalShortcuts")]: "u 1",
  };
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "sway" }),
    run: fakeRun(sway),
    pin: pin(45),
  });
  assertEquals(
    [report.linux?.portalRegistry, report.linux?.systemdUser, report.linux?.launcherBadges],
    [false, false, false],
  );
  assertEquals(report.findings.map((f) => f.check), [
    "notification-clicks",
    "scheduled-notifications",
    "badge",
  ]);
  assertStringIncludes(report.findings[0].fix, "1.19");
  assert(report.checks.includes("notification-clicks"));
  // The same session under a runtime before denext.11: one runtime finding, no session ones.
  const older = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "wayland" }),
    run: fakeRun(sway),
    pin: pin(45, "2.9.7-denext.10"),
  });
  assertEquals(older.runtime.linuxNotifications, false);
  assertEquals(older.findings.map((f) => `${f.level}:${f.check}`), ["warning:runtime"]);
  assertStringIncludes(older.findings[0].message, "predates Linux notification cold starts");
  assertStringIncludes(older.findings[0].fix, "2.9.7-denext.11");
  assert(!older.checks.includes("badge"));
  // gdbus: the registry from the portal's introspection.
  const gdbus = "gdbus call --session --timeout 5";
  const facts = await probeLinuxSession(
    fakeRun({
      busctl: null,
      [`${gdbus} --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames`]:
        "(['org.freedesktop.portal.Desktop', 'org.freedesktop.systemd1', 'com.canonical.Unity'],)",
      [`${gdbus} --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListActivatableNames`]:
        "([],)",
      "gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop":
        "node /org/freedesktop/portal/desktop {\n  interface org.freedesktop.host.portal.Registry {\n",
    }),
    env({ XDG_SESSION_TYPE: "wayland" }),
  );
  assertEquals([facts.portalRegistry, facts.systemdUser, facts.launcherBadges], [
    true,
    true,
    true,
  ]);
});

Deno.test("desktop doctor: the CLI prints JSON (or text) and passes --linux through", async () => {
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    const ctx = (json: boolean, flags: Record<string, unknown> = {}) =>
      ({ flags, positionals: ["doctor"], global: { json } }) as unknown as CommandContext;
    const seams = {
      runtimeStatus: () => Promise.resolve(status()),
      os: "linux",
      env: env({ XDG_SESSION_TYPE: "wayland" }),
      run: fakeRun(FULL),
      pin: pin(45),
    };
    const report = await desktopDoctor(ctx(true, { linux: true }), "/app", seams);
    assertEquals(JSON.parse(logs.at(-1)!).linux.trayHost, true);
    assertEquals(report.findings, []);
    await desktopDoctor(ctx(false), "/app", seams);
    assertStringIncludes(logs.join("\n"), "denext desktop doctor  ▸  /app");
    assertStringIncludes(logs.join("\n"), "All checks passed.");
  } finally {
    console.log = log;
  }
});

Deno.test("desktop doctor: the default runner captures stdout and reads a missing tool as null", async () => {
  const { defaultDoctorRunner } = await import("../src/build/desktop-doctor.ts");
  const out = await defaultDoctorRunner(Deno.execPath(), ["eval", "console.log('hi')"]);
  assertEquals(out?.code, 0);
  assertStringIncludes(out!.stdout, "hi");
  assertEquals(await defaultDoctorRunner("denext-no-such-tool-xyz", []), null);
});

// ── The CLI (`denext desktop doctor`): flags, output, exit codes ───────────────────────────────

/** Drive `desktopDoctor` with Deno.exit stubbed; the exit code (0 when it returned) and output. */
async function runCli(
  flags: Record<string, unknown>,
  json: boolean,
  dir: string,
  seams: Parameters<typeof desktopDoctor>[2],
): Promise<{ code: number; out: string; err: string; report?: DesktopDoctorReport }> {
  const cap = capture();
  const exit = stubExit();
  const ctx = {
    flags,
    positionals: ["doctor"],
    global: { json },
    rest: [],
  } as unknown as CommandContext;
  let code = 0;
  let report: DesktopDoctorReport | undefined;
  try {
    report = await desktopDoctor(ctx, dir, seams);
  } catch (e) {
    if (!String(e).includes("__exit__")) throw e;
    code = exit.calls[0];
  } finally {
    exit.restore();
    cap.restore();
  }
  return { code, out: cap.logs.join("\n"), err: cap.errs.join("\n"), report };
}

Deno.test("desktop doctor CLI: --linux off Linux exits 1 before reading anything", async () => {
  const calls: string[] = [];
  let statusRead = false;
  const r = await runCli({ linux: true }, false, "/app", {
    os: "darwin",
    runtimeStatus: () => {
      statusRead = true;
      return Promise.resolve(status());
    },
    run: fakeRun(FULL, calls),
    pin: pin(45),
  });
  assertEquals(r.code, 1);
  assertStringIncludes(r.err, "--linux reads the session it runs in; run it on the Linux desktop");
  assertEquals([statusRead, calls, r.out], [false, [], ""]);
});

Deno.test("desktop doctor CLI: an error finding exits 1 after printing it with its fix", async () => {
  const seams = {
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "tty" }),
    runtimeStatus: () => Promise.resolve(status()),
    run: fakeRun({ [BUSCTL_LIST]: 1, gdbus: null }),
    pin: pin(45),
  };
  const text = await runCli({ linux: true }, false, "/srv/app", seams);
  assertEquals(text.code, 1);
  assertStringIncludes(text.out, "denext desktop doctor  ▸  /srv/app");
  assertStringIncludes(text.out, "✖ session-bus");
  assertStringIncludes(text.out, "ERROR   [session-bus] no D-Bus session bus answered");
  assertStringIncludes(text.out, "fix: run inside a desktop session, or start one with");
  assertStringIncludes(text.out, "WARNING [session] no graphical session in this terminal");
  assertStringIncludes(text.out, "1 error(s), 1 warning(s).");
  // --json: one JSON document (no header), and the same exit code.
  const json = await runCli({ linux: true }, true, "/srv/app", seams);
  assertEquals(json.code, 1);
  assertEquals(json.out.includes("▸"), false);
  const parsed = JSON.parse(json.out) as DesktopDoctorReport;
  assertEquals(parsed.findings.map((f) => `${f.level}:${f.check}`), [
    "warning:session",
    "error:session-bus",
  ]);
  assertEquals(parsed.linux?.secretService, "no-session-bus");
});

Deno.test("desktop doctor CLI: warnings alone exit 0, each Linux gap printed with its fix", async () => {
  const r = await runCli({}, false, "/app", {
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" }),
    runtimeStatus: () => Promise.resolve(status()),
    run: fakeRun({
      [BUSCTL_LIST]: "org.freedesktop.portal.Desktop 903 xdg-desktop-por nightness :1.12 - 2 -",
      [portalProp("Notification")]: "u 2",
      [LDCONFIG]: NO_LIBSECRET,
    }),
    pin: pin(45),
  });
  assertEquals(r.code, 0, r.err);
  assertEquals(r.report?.findings.map((f) => f.check), [
    "tray-host",
    "secret-service",
    "libsecret",
    "notifications",
    "portal",
    "portal",
    "scheduled-notifications",
    "badge",
  ]);
  for (const f of r.report!.findings) {
    assertEquals(f.level, "warning", f.check);
    assertStringIncludes(r.out, `WARNING [${f.check}] ${f.message}`);
    assertStringIncludes(r.out, `fix: ${f.fix}`);
  }
  assertStringIncludes(r.out, "gnome-extensions enable");
  assertStringIncludes(r.out, "libsecret-1-0");
  assertStringIncludes(r.out, "mako or dunst");
  assertStringIncludes(r.out, "0 error(s), 8 warning(s).");
});

Deno.test("desktop doctor CLI: the Linux checks (and the pre-probe pin warning) default to the host", async () => {
  // No --linux on a Linux host: the session is probed, and a pin without
  // Deno.desktop.platformFeatures() is a warning (the facts read "unknown" there).
  const calls: string[] = [];
  const linux = await runCli({}, true, "/app", {
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "wayland" }),
    runtimeStatus: () => Promise.resolve(status()),
    run: fakeRun(FULL, calls),
    pin: pin(44),
  });
  assertEquals(linux.code, 0, linux.err);
  assert(calls.includes(BUSCTL_LIST), "the session bus was read");
  const report = JSON.parse(linux.out) as DesktopDoctorReport;
  assertEquals(report.checks.slice(0, 3), ["runtime", "session", "session-bus"]);
  assertEquals(report.findings.map((f) => `${f.level}:${f.check}`), ["warning:runtime"]);
  assertStringIncludes(report.findings[0].message, "predates Deno.desktop.platformFeatures()");
  // Off Linux: no probe at all, and the same pin is not a finding.
  const offCalls: string[] = [];
  const mac = await runCli({}, true, "/app", {
    os: "darwin",
    runtimeStatus: () => Promise.resolve(status()),
    run: fakeRun(FULL, offCalls),
    pin: pin(44),
  });
  assertEquals(mac.code, 0, mac.err);
  assertEquals(offCalls, []);
  assertEquals(JSON.parse(mac.out).linux, null);
  assertEquals(JSON.parse(mac.out).findings, []);
});

Deno.test("desktop doctor CLI: without a seam the runtime status is read from the project dir", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denext_desktop_doctor_cli_" });
  const keys = ["DENEXT_DESKTOP_RUNTIME", "DENEXT_DESKTOP_RUNTIME_DIR"];
  const prev = keys.map((k) => Deno.env.get(k));
  try {
    for (const k of keys) Deno.env.delete(k);
    // A backend the pinned runtime does not ship: the project's deno.json was read.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ desktop: { backend: "gtk4" } }),
    );
    const bad = await runCli({}, true, dir, { os: "darwin" });
    assertEquals(bad.code, 1, "an unpinned runtime is an error");
    const report = JSON.parse(bad.out) as DesktopDoctorReport;
    assertEquals(report.runtime.status.mode, "pinned");
    assertEquals(report.runtime.status.backend, null);
    assertStringIncludes(report.runtime.status.detail, 'desktop.backend is "gtk4"');
    // The unpinned backend is an error; a `deno` other than the pin's exact version (CI's unit job
    // runs a newer one) adds its own runtime error, so this test reads the deno it ran under.
    const denoMatches = report.runtime.status.deno.found === report.runtime.status.deno.required;
    assertEquals(
      report.findings.map((f) => `${f.level}:${f.check}`),
      denoMatches ? ["error:runtime"] : ["error:runtime", "error:runtime"],
    );
    assert(report.findings.some((f) => f.message.includes("no pinned runtime build")));
    // DENEXT_DESKTOP_RUNTIME=stock (read from this process's env): a warning, exit 0.
    Deno.env.set("DENEXT_DESKTOP_RUNTIME", "stock");
    const stock = await runCli({}, false, dir, { os: "darwin" });
    assertEquals(stock.code, 0, stock.err);
    assertEquals(stock.report?.runtime.status.mode, "stock");
    assertStringIncludes(stock.out, "WARNING [runtime]");
    assertStringIncludes(stock.out, "DENEXT_DESKTOP_RUNTIME=stock");
  } finally {
    keys.forEach((k, i) => prev[i] === undefined ? Deno.env.delete(k) : Deno.env.set(k, prev[i]!));
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("desktop doctor: a declared wayland session with only an X display is x11", () => {
  // GDM registers an Xorg session (XFCE, i3) as wayland; CEF believing it opens no window.
  assertEquals(sessionTypeOf(env({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" })), "x11");
  const socket = (path: string) => path === "/run/user/1000/wayland-0";
  assertEquals(
    sessionTypeOf(
      env({
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: "wayland-0",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DISPLAY: ":0",
      }),
      socket,
    ),
    "wayland",
  );
  assertEquals(sessionTypeOf(env({ XDG_SESSION_TYPE: "wayland" })), "wayland");
  // As the runtime reports it: a display alone never makes a session graphical (Xvfb under cron).
  assertEquals(sessionTypeOf(env({ DISPLAY: ":0" })), "unknown");
  // A WAYLAND_DISPLAY whose socket is gone is not a Wayland display; an absolute one, or a
  // handed-over WAYLAND_SOCKET, is.
  assertEquals(
    sessionTypeOf(
      env({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-9", DISPLAY: ":1" }),
      socket,
    ),
    "x11",
  );
  assertEquals(
    sessionTypeOf(
      env({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "/tmp/w" }),
      (p) => p === "/tmp/w",
    ),
    "wayland",
  );
  assertEquals(
    sessionTypeOf(env({ XDG_SESSION_TYPE: "wayland", WAYLAND_SOCKET: "3", DISPLAY: ":0" })),
    "wayland",
  );
  assertEquals(sessionTypeOf(env({ XDG_SESSION_TYPE: "TTY", DISPLAY: ":0" })), "tty");
});

Deno.test("desktop doctor: the CEF sandbox — namespaces, the setuid helper, root; requireSandbox", async () => {
  const cef = status({ backend: "cef" });
  const run = (over: Record<string, string | number | null>) =>
    runDesktopDoctor({
      runtimeStatus: () => Promise.resolve(cef),
      os: "linux",
      env: env({ XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" }),
      run: fakeRun({ ...FULL, ...over }),
      pin: pin(47, "2.9.7-denext.12"),
    });
  const namespace = await run({});
  assertEquals(namespace.linux?.sandbox.mode, "namespace");
  assertEquals(namespace.findings, []);
  assert(namespace.checks.includes("sandbox"));
  assertStringIncludes(formatDesktopDoctor(namespace), "sandbox   CEF: namespace");
  // Ubuntu 23.10+: AppArmor restricts user namespaces; only the .deb / .rpm's helper sandboxes.
  const ubuntu = await run({ [UNSHARE]: 1, [APPARMOR]: "1\n" });
  assertEquals(ubuntu.linux?.sandbox.mode, "helper");
  assertEquals(ubuntu.findings.map((f) => `${f.level}:${f.check}`), ["warning:sandbox"]);
  const [finding] = ubuntu.findings;
  assertStringIncludes(finding.message, "kernel.apparmor_restrict_unprivileged_userns=1");
  assertStringIncludes(finding.message, "AppImage");
  assertStringIncludes(finding.fix, "desktop.linux.requireSandbox: true");
  assertStringIncludes(finding.fix, "LAUFEY_REQUIRE_SANDBOX=1");
  assertStringIncludes(finding.fix, "status 78");
  assertStringIncludes(formatDesktopDoctor(ubuntu), "setuid from a .deb / .rpm install");
  const container = await run({ [UNSHARE]: 1 });
  assertStringIncludes(container.linux!.sandbox.reason, "not available");
  const root = await run({ "id -u": "0\n" });
  assertEquals(root.linux?.sandbox.mode, "off");
  assertStringIncludes(root.findings[0].message, "root");
  const noUnshare = await run({ [UNSHARE]: null });
  assertEquals([noUnshare.linux?.sandbox.mode, noUnshare.findings], ["unknown", []]);
  // The WebView backend has no Chromium sandbox: the fact is listed, never a finding.
  const webview = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "wayland" }),
    run: fakeRun({ ...FULL, [UNSHARE]: 1 }),
    pin: pin(47, "2.9.7-denext.12"),
  });
  assertEquals(webview.findings, []);
  assert(!webview.checks.includes("sandbox"));
});

Deno.test("desktop doctor: a portal that doesn't start is not a portal that is too old", async () => {
  const session = {
    [BUSCTL_LIST]: [
      "org.kde.StatusNotifierWatcher 1 a b - - - -",
      "org.freedesktop.Notifications 1 a b - - - -",
      "org.freedesktop.portal.Desktop - - - (activatable) - -",
      "org.freedesktop.secrets 1 a b - - - -",
      "org.freedesktop.systemd1 1 a b - - - -",
      "com.canonical.Unity 1 a b - - - -",
    ].join("\n"),
    [LOCKED]: "b false",
    [LDCONFIG]: LIBSECRET,
    [UNSHARE]: 0,
  };
  // Activatable, but every call fails: D-Bus could not start it.
  const dead = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "wayland" }),
    run: fakeRun({
      ...session,
      [REGISTRY]: { code: 1, stderr: "Failed to introspect: Process exited with status 1" },
    }),
    pin: pin(47, "2.9.7-denext.12"),
  });
  assertEquals([dead.linux?.portal, dead.linux?.portalAnswered], [true, false]);
  assertEquals(dead.findings.map((f) => f.check), ["portal"]);
  assertStringIncludes(dead.findings[0].message, "did not answer");
  assertStringIncludes(dead.findings[0].fix, "systemctl --user status xdg-desktop-portal");
  assertStringIncludes(formatDesktopDoctor(dead), "installed, did not answer");
  // It answers, without the registry: too old (1.19).
  const old = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "wayland" }),
    run: fakeRun({
      ...session,
      [portalProp("FileChooser")]: "u 4",
      [portalProp("GlobalShortcuts")]: "u 1",
    }),
    pin: pin(47, "2.9.7-denext.12"),
  });
  assertEquals(old.findings.map((f) => f.check), ["notification-clicks"]);
  assertStringIncludes(old.findings[0].message, "older than 1.19");
});

Deno.test("desktop doctor: an activatable notification server that fails to start shows why", async () => {
  const calls: string[] = [];
  const start = "busctl --user --timeout=5 call org.freedesktop.DBus /org/freedesktop/DBus " +
    "org.freedesktop.DBus StartServiceByName su org.freedesktop.Notifications 0";
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }),
    run: fakeRun({
      [BUSCTL_LIST]: [
        "org.freedesktop.Notifications - - - (activatable) - -",
        "org.freedesktop.secrets 1 a b - - - -",
        "org.freedesktop.systemd1 1 a b - - - -",
        "com.canonical.Unity 1 a b - - - -",
      ].join("\n"),
      [LOCKED]: "b false",
      [LDCONFIG]: LIBSECRET,
      [UNSHARE]: 0,
      [start]: {
        code: 1,
        stderr: "Call failed: Process org.freedesktop.Notifications exited with status 1\n",
      },
    }, calls),
    pin: pin(47, "2.9.7-denext.12"),
  });
  assert(calls.includes(start), "started as the runtime would on first use");
  assertEquals(report.linux?.notifications, false);
  const byCheck = Object.fromEntries(report.findings.map((f) => [f.check, f]));
  assertEquals(
    byCheck.notifications.message,
    "D-Bus could not start the notification server for org.freedesktop.Notifications: " +
      "Process org.freedesktop.Notifications exited with status 1",
  );
  assertStringIncludes(byCheck.notifications.fix, "journalctl --user");
  // No StatusNotifierWatcher on X11: the XEmbed tray the runtime also uses is named.
  assertStringIncludes(byCheck["tray-host"].message, "XEmbed system tray");
  assertStringIncludes(byCheck["tray-host"].fix, "XEmbed");
  assertStringIncludes(formatDesktopDoctor(report), "an XEmbed tray is not visible from here");
});
