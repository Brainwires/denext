// `denext mobile inspect`: attach a web inspector to the app's WebView on a device. It prints the
// steps for each platform and, where the host can, opens the inspector: Safari on macOS for iOS
// (the Develop menu then lists the device), and `chrome://inspect/#devices` in Chrome for Android
// (after `adb devices`, when adb is on the PATH, so a missing authorisation shows up first).
// Best effort: nothing it opens is required, and every step is printed either way.
//
// Sources: Safari Web Inspector for iOS apps (Settings → Apps → Safari → Advanced → Web Inspector
// on the device; debuggable web content in iOS 16.4+ via WKWebView.isInspectable, which Capacitor
// sets from ios.webContentsDebuggingEnabled / debug builds):
//   https://developer.apple.com/documentation/safari-developer-tools/inspecting-ios
//   https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/
// Chrome remote debugging of Android WebViews (USB debugging, chrome://inspect):
//   https://developer.chrome.com/docs/devtools/remote-debugging/webviews

/** Which platform's steps (`all`: both). */
export type InspectPlatform = "ios" | "android" | "all";

/** Runs a command and resolves its exit code and stdout (tests pass a fake). */
export type InspectRunner = (
  cmd: string,
  args: readonly string[],
) => Promise<{ code: number; stdout: string }>;

/** The host OS the commands are chosen for. */
export type HostOs = "darwin" | "linux" | "windows" | string;

/** The steps for iOS, as lines. */
function iosSteps(appName: string): string[] {
  return [
    "iOS (Safari Web Inspector, macOS only):",
    "  1. On the device: Settings → Apps → Safari → Advanced → Web Inspector: on.",
    "  2. Connect it by cable (or pair it for network debugging in Xcode → Devices), unlock it,",
    "     and trust this Mac.",
    '  3. On the Mac: Safari → Settings → Advanced → "Show features for web developers".',
    `  4. Run a debug build (Xcode, \`npx cap run ios\` or \`denext mobile dev\`) and open ${appName}.`,
    "  5. Safari → Develop → <your device> → the app's page (capacitor://localhost, or the dev",
    "     server during `denext mobile dev`).",
    "  A release / TestFlight build is inspectable only with ios.webContentsDebuggingEnabled: true,",
    "  which must not ship (`denext mobile doctor --release` flags it).",
  ];
}

/** The steps for Android, as lines. */
function androidSteps(appName: string): string[] {
  return [
    "Android (Chrome DevTools):",
    "  1. On the device: Settings → About phone → tap Build number 7 times, then Developer",
    "     options → USB debugging: on.",
    '  2. Connect it by cable and accept the "Allow USB debugging" prompt (`adb devices` lists',
    "     it as `device`, not `unauthorized`). An emulator needs nothing.",
    `  3. Run a debug build (\`npx cap run android\` or \`denext mobile dev\`) and open ${appName}.`,
    "  4. In Chrome on this computer: chrome://inspect/#devices → the WebView → inspect.",
    "  A release build is inspectable only with android.webContentsDebuggingEnabled: true, which",
    "  must not ship.",
  ];
}

/** What the dev server shows from the device. */
const CONSOLE_NOTE = [
  "Logs without an inspector:",
  "  - During `denext mobile dev` the page is served by `denext dev`: an App Router app reports",
  "    console.error / console.warn and uncaught errors back to it, readable with the",
  "    `denext_dev_logs` MCP tool or GET /_denext/dev-state (a SPA-mode app does not forward them;",
  "    use the inspector).",
  "  - Xcode's console (iOS) and `adb logcat` (Android) show the native side and, with",
  "    loggingBehavior \"debug\" (Capacitor's default), the page's console in debug builds.",
  "  - In release, report errors to a service instead (`denext mobile add sentry`).",
];

/**
 * The steps to attach an inspector, as printable lines.
 *
 * @param platform Which platform(s).
 * @param appName The app's name for the steps (the Capacitor `appName`).
 * @returns The lines.
 */
export function inspectSteps(platform: InspectPlatform, appName = "the app"): string[] {
  const out: string[] = [];
  if (platform !== "android") out.push(...iosSteps(appName), "");
  if (platform !== "ios") out.push(...androidSteps(appName), "");
  return [...out, ...CONSOLE_NOTE];
}

/** The command that opens Chrome at `url` on `os`, or null when unknown. */
function chromeCommand(os: HostOs, url: string): { cmd: string; args: string[] } | null {
  if (os === "darwin") return { cmd: "open", args: ["-a", "Google Chrome", url] };
  if (os === "linux") return { cmd: "google-chrome", args: [url] };
  if (os === "windows") return { cmd: "cmd", args: ["/c", "start", "chrome", url] };
  return null;
}

/** Run `cmd`, turning a spawn failure (not installed) into a non-zero code. */
async function tryRun(
  run: InspectRunner,
  cmd: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string }> {
  try {
    return await run(cmd, args);
  } catch {
    return { code: 127, stdout: "" };
  }
}

/** iOS: open Safari (macOS only). */
async function openIos(run: InspectRunner, os: HostOs): Promise<string> {
  if (os !== "darwin") return "  iOS: Safari's Web Inspector needs a Mac; skipped.";
  const { code } = await tryRun(run, "open", ["-a", "Safari"]);
  return code === 0
    ? "  iOS: opened Safari; pick Develop → <your device> → the app's page."
    : "  iOS: could not open Safari; open it and use the Develop menu.";
}

/** The device serials `adb devices` lists as `device`, and the unauthorised ones. */
function adbDevices(stdout: string): { ready: string[]; unauthorized: string[] } {
  const rows = stdout.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((r) =>
    r.length >= 2
  );
  return {
    ready: rows.filter((r) => r[1] === "device").map((r) => r[0]),
    unauthorized: rows.filter((r) => r[1] === "unauthorized").map((r) => r[0]),
  };
}

/** Android: list devices with adb, then open chrome://inspect. */
async function openAndroid(run: InspectRunner, os: HostOs): Promise<string[]> {
  const lines: string[] = [];
  const adb = await tryRun(run, "adb", ["devices"]);
  if (adb.code === 0) {
    const { ready, unauthorized } = adbDevices(adb.stdout);
    lines.push(
      ready.length > 0
        ? `  Android: adb sees ${ready.join(", ")}.`
        : "  Android: adb sees no device (connect one with USB debugging on, or start an emulator).",
    );
    if (unauthorized.length > 0) {
      lines.push(
        `  Android: ${unauthorized.join(", ")} unauthorized: accept the prompt on the device.`,
      );
    }
  } else {lines.push(
      "  Android: adb is not on the PATH (Android SDK platform-tools); skipped the device list.",
    );}
  const chrome = chromeCommand(os, "chrome://inspect/#devices");
  const opened = chrome !== null && (await tryRun(run, chrome.cmd, chrome.args)).code === 0;
  lines.push(
    opened
      ? "  Android: opened chrome://inspect/#devices in Chrome."
      : "  Android: open chrome://inspect/#devices in Chrome yourself.",
  );
  return lines;
}

/**
 * Open what the host can open for inspecting the app, best effort.
 *
 * @param platform Which platform(s).
 * @param run Runs a command (tests pass a fake).
 * @param os The host OS (`Deno.build.os`).
 * @returns One line per action taken or skipped.
 */
export async function openInspector(
  platform: InspectPlatform,
  run: InspectRunner,
  os: HostOs,
): Promise<string[]> {
  const lines: string[] = [];
  if (platform !== "android") lines.push(await openIos(run, os));
  if (platform !== "ios") lines.push(...await openAndroid(run, os));
  return lines;
}
