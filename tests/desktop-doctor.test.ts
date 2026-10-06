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
} from "../src/build/desktop-doctor.ts";
import type { DesktopRuntimePin, DesktopRuntimeStatus } from "../src/build/desktop-runtime.ts";
import { desktopDoctor } from "../src/cli/commands/desktop-doctor.ts";
import type { CommandContext } from "../src/cli/command.ts";

/** A runner answering from `answers` (`"cmd arg…"` → stdout, or a code), recording each call. */
function fakeRun(answers: Record<string, string | number | null>, calls: string[] = []) {
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
  "secret-tool": 2,
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
    secretTool: true,
    sessionBus: true,
    trayHost: true,
    secretService: "available",
    notifications: true,
    portal: true,
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

Deno.test("desktop doctor: stock GNOME — no tray host, a locked keyring, no secret-tool, no shortcuts portal", async () => {
  const report = await runDesktopDoctor({
    runtimeStatus: () => Promise.resolve(status()),
    os: "linux",
    env: env({ WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }),
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
      "secret-tool": null,
    }),
    pin: pin(45),
  });
  assertEquals(report.linux?.sessionType, "wayland", "from WAYLAND_DISPLAY");
  assertEquals(report.findings.map((f) => `${f.level}:${f.check}`), [
    "warning:tray-host",
    "warning:secret-service",
    "warning:secret-tool",
    "warning:portal",
    "warning:badge",
  ]);
  const tray = report.findings[0];
  assertStringIncludes(tray.fix, "gnome-extensions enable");
  assertStringIncludes(report.findings[1].message, "--password-store=basic");
  assertStringIncludes(report.findings[2].fix, "libsecret-tools");
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
      "secret-tool": 2,
    }, calls),
    env({ DISPLAY: ":0" }),
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
    env: env({ DISPLAY: ":0" }),
    run: fakeRun({
      [BUSCTL_LIST]: "org.kde.StatusNotifierWatcher 1 x y - - - -",
      "secret-tool": 2,
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
      "secret-tool": 2,
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
      "secret-tool": 2,
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
    run: fakeRun({ [BUSCTL_LIST]: 1, gdbus: null, "secret-tool": null }),
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
    run: fakeRun({ busctl: null, gdbus: null, "secret-tool": null }),
    pin: pin(45),
  });
  assertEquals(noTools.linux?.probe, null);
  assertEquals(noTools.linux?.sessionType, "unknown");
  assertEquals(noTools.findings.map((f) => f.check), ["session", "session-bus", "secret-tool"]);
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
    "secret-tool": 2,
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
      "secret-tool": 2,
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
