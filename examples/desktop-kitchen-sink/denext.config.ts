import type { DenextConfig } from "denext/server";

/**
 * The full-app updater's public key. `e2e/window-test.ts` generates a throwaway key pair per run
 * and passes the public half here at PACKAGE time (it is baked into `.deno-desktop/app.json`); a
 * normal package has none, so the app is built without full-app updates. The packaged app reads
 * this config again at launch, where the variable is unset and nothing reads the key.
 */
function packagingUpdateKey(): string | undefined {
  try {
    return Deno.env.get("KITCHEN_SINK_UPDATE_PUBLIC_KEY") || undefined;
  } catch {
    return undefined; // no env permission
  }
}

const updatePublicKey = packagingUpdateKey();

// Every shipped Deno Desktop capability, on: the window test (`deno task test:window`) drives each
// one from the page and asserts the results. Pinned-runtime features (the stable app origin,
// preload, deep links, single instance, the window API, the full-app updater) need denext's pinned
// Deno Desktop runtime, which `denext desktop run` and the package scripts download and verify.
export default {
  desktop: {
    // The window test launches the bundle itself, so build no installers (an empty list = just the
    // .app / app directory): a .dmg doubled the macOS CI runner's disk use and ran it out of space.
    installers: { macos: [], linux: [], windows: [] },
    app: {
      // Keys the OS storage dirs, the keychain service and the window origin's storage.
      identifier: "dev.denext.kitchen-sink",
      // A stable origin (a custom scheme), so browser storage survives relaunches.
      origin: "kitchensink://app",
      // Links with this scheme reach `onDeepLink`; files the OS opens reach `onOpenFile`.
      deepLinks: ["kitchensink-link"],
      // A second launch hands its links and files to the running app and exits.
      singleInstance: true,
    },
    // Runs in the window before the page's own scripts (Electron's preload).
    preload: "./desktop/preload.ts",
    window: { width: 980, height: 760, title: "denext kitchen sink" },
    minSize: { width: 420, height: 320 },
    capabilities: {
      // The bridge diagnostic: an RPC that pushes an event back (checks the event stream).
      echo: true,
      secureStore: true,
      fs: true,
      sqlite: true,
      device: true,
      dialogs: true,
      keepAwake: true,
      clipboard: true,
      // The OS's notifications and context menu, system-wide shortcuts and the login item.
      notifications: true,
      contextMenu: true,
      globalShortcuts: true,
      launchAtLogin: true,
      // System-browser sign-in with a custom-scheme callback (`openAuthSession`); the window test
      // puts a stand-in browser first on PATH, so no real browser opens.
      authSession: true,
      // Native passkeys, pinned to relying parties the test never reaches the OS with: one the
      // native parser refuses (`bad_rp.invalid` is not a domain name) proves the runtime path
      // without a ceremony; any other RP is refused by the capability itself.
      passkeys: { rpIds: ["bad_rp.invalid"] },
      // Only https links, and the app-folder actions the test can run unattended.
      shell: {
        openExternal: ["https:"],
        openPath: false,
        reveal: false,
        trash: true,
      },
      // The test harness: reports results, loads the Node-API addon, checks for updates.
      extensions: ["./desktop/kitchen.ts"],
    },
    // The Node-API addon is a native library the Deno process loads: an unscoped `--allow-ffi`,
    // since the packaged app loads it from its embedded file system (no nameable path).
    extraPermissions: { ffi: ["*"] },
    // `autoConfirm: false` (read again at launch, unlike the key): the page confirms, or, on the
    // window test's trial launch of a new version, deliberately does not, so the next launch rolls
    // the update back.
    update: { autoConfirm: false, ...(updatePublicKey ? { publicKey: updatePublicKey } : {}) },
  },
} satisfies DenextConfig;
