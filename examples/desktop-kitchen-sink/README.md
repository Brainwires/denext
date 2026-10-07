# Desktop kitchen sink (every Deno Desktop capability, window-tested)

A denext desktop app that turns on every shipped Deno Desktop capability and calls each one from the
page, plus an automated window test that packages the app, launches it and asserts every result: the
keychain, files, SQLite, device facts, keep-awake, the clipboard (text, HTML, PNG), the shell,
native dialogs, the window API, drag and drop, the OS's notifications and context menu, the
application menu, a tray icon, the Dock / taskbar badge, global shortcuts, launch at login, the
DevTools switch, deep links and opened files, a second instance, the preload, the stable app origin,
a Node-API addon, the bridge's gate, custom-scheme auth sessions, passkeys, the Clerk bridge, links
between the export's pages (soft navigations, back, and a full-page load that keeps the bridge), a
platform-specific file (`components/PlatformBadge.desktop.tsx`, imported through the `@/` alias,
rendered and hydrated instead of the plain web file) and the full-app updater (a real update
installed, left unconfirmed and rolled back).

CI runs it on Linux, macOS (Apple silicon and Intel) and Windows
(`.github/workflows/desktop-window.yml`): nightly, and on pushes that touch the desktop code.

## Run it

```
deno task desktop            # export + open the window (denext's pinned runtime, Deno 2.9.7)
deno task desktop:package    # write scripts/package-*.ts from the scaffold, then package
deno task test:window        # package, launch and assert every check (exits 1 on a failure)
deno task test:window --no-package   # reuse the last builds in dist/ (and their update key)
deno task test:window --no-update    # skip the full-app update install / rollback launches
```

Opened by hand, the window lists the checks and runs them on **Run checks**; the launch checks (a
cold-start deep link, a file the OS opens with the app, a link a second launch forwards) and the
updater checks are skipped there, because only the test runner sets them up.

### Manual release checks

Opened by hand (never under the window test), the window also shows **Manual release checks**:
buttons for the rows of CONTRIBUTING.md › _Manual desktop checks before a final release_ that need a
person at the screen. Nothing in the panel runs until you click.

- **Passkey**: _Create passkey_, then _Sign in with passkey_, through the `passkeys` capability, for
  the relying party in the panel's field (it defaults to the first RP pinned in
  `desktop.capabilities.passkeys.rpIds`, `denext.dev`; an RP not pinned answers `invalid_rp`). It
  shows whether the platform authenticator is ready (`passkeys.capabilities()`), then the credential
  id or the error code. Windows Hello needs no association between the app and the RP (set up a PIN
  in Settings › Accounts › Sign-in options first); macOS also needs the associated-domains
  entitlement, so an unentitled build answers `invalid_rp`. A macOS build for it sets
  `desktop.app.identifier` to an App ID with Associated Domains, and `desktop.macos` to that App
  ID's Developer ID provisioning profile plus
  `entitlements: { "com.apple.developer.associated-domains": ["webcredentials:<rp>"] }`; the RP
  serves `/.well-known/apple-app-site-association` listing `<TeamID>.<identifier>` under
  `webcredentials`. The passkey lands in the OS's passkey list (Windows: Settings › Accounts ›
  Passkeys); delete it there afterwards.
- **Backdrop**: none / mica / acrylic / tabbed (and vibrancy on macOS), with what
  `windowCapabilities()` reports; the page turns transparent while one is applied, so the whole
  window background should change.
- **HiDPI**: `devicePixelRatio`, the window bounds and every screen's scale factor (live), a test
  pattern drawn in device pixels (sharp only when the scale is right) and text, and _Save_ /
  _Restore placement_ for the size-and-position restore check across monitors and scales.

`deno task test:window` needs a display and a desktop session:

- **macOS**: a logged-in session. The clipboard checks put your clipboard text back afterwards.
- **Linux**: a window manager (maximize is a window-manager request on X11), an unlocked Secret
  Service for `secureStore` (the pinned runtime reaches it through libsecret, `libsecret-1-0` on
  Debian / Ubuntu; there is no `secret-tool` path) and a notification server.
  `e2e/linux-session.sh deno task test:window` runs it headless (Xvfb, xfwm4, a private D-Bus
  session, gnome-keyring, dunst), with `XDG_DATA_HOME` / `XDG_CONFIG_HOME` pointed at a scratch
  folder so a fresh login keyring is created there and yours is never touched.
- **Windows**: the interactive desktop session (from SSH, start it from an `/it` scheduled task).

## What each check proves

| Area             | Through                                                 | Asserted                                                                                                                                                             |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | `runtimePlatform()`, `Deno.desktop`                     | a desktop window on denext's pinned runtime                                                                                                                          |
| App origin       | `desktop.app.origin`                                    | `location.origin` is `kitchensink://app`                                                                                                                             |
| Bridge events    | the `echo` diagnostic capability                        | an event the runtime pushes reaches the page                                                                                                                         |
| Preload          | `desktop.preload`                                       | ran before the page's scripts, after the `__denext` global                                                                                                           |
| `secureStore`    | `secureStore` (`denext/mobile`)                         | the entry is in the OS keychain, then gone                                                                                                                           |
| `fs`             | `writeFile` / `readFile` / `listDir` / `deleteFile`     | the file is on disk in the data folder                                                                                                                               |
| `sqlite`         | `openSqlite`                                            | a native `node:sqlite` database, not OPFS                                                                                                                            |
| `device`         | `deviceInfo`                                            | the runtime's OS and model                                                                                                                                           |
| `keepAwake`      | the capability's `acquire` / `release`                  | the OS assertion is held and released                                                                                                                                |
| `clipboard`      | `writeClipboard` / `readClipboard` / `clipboardFormats` | text, HTML and a PNG round trip                                                                                                                                      |
| `shell`          | `moveToTrash`, `openExternal`                           | an app file goes to the trash; what the config forbids is refused                                                                                                    |
| `dialogs`        | `windowCapabilities().fileDialogs`                      | native dialogs exist; bad arguments are refused before a panel opens                                                                                                 |
| Window           | `denext/desktop/window`                                 | state, screens, size, min/max clamp, maximize, backdrop, a guarded close                                                                                             |
| Title bar        | `getTitleBarPreferences` (`denext/desktop/window`)      | the user's button side and order and double-click action (macOS left, Windows right, Linux the desktop's own)                                                        |
| Drag and drop    | `onFileDrop`, `startFileDrag`                           | the plumbing: no drag without a held button, no path escapes                                                                                                         |
| DevTools         | `desktop.inspectable` (unset)                           | off in the packaged app                                                                                                                                              |
| App menu         | `setAppMenu`, `onAppMenuItem` (`denext/desktop/app`)    | accelerators + roles accepted; a (synthetic) OS menu click reaches the page                                                                                          |
| Tray, Dock       | `createTray`, `setBadge`, `bounce`, `setQuickActions`   | a tray icon with bounds and a menu; the badge; the macOS Dock menu                                                                                                   |
| Notifications    | `scheduleNotification`, `pendingNotifications`, …       | scheduled and cancelled in the OS; a daily one 16 ahead; a (synthetic) click                                                                                         |
| Context menu     | the `contextMenu` capability                            | native with dismissal; bad items refused before it opens                                                                                                             |
| Shortcuts        | `registerShortcut` (`denext/desktop/app`)               | registered, listed, a (synthetic) press reaches the handler, released                                                                                                |
| Launch at login  | `getLaunchAtLogin` / `setLaunchAtLogin`                 | the state; toggled on and off on Windows and Linux                                                                                                                   |
| Deep links       | `onDeepLink`, `desktop.app.deepLinks`                   | a cold-start link, and one a second launch forwards (`singleInstance`)                                                                                               |
| Opened files     | `onOpenFile`                                            | a read-only handle that reads the file and refuses writes                                                                                                            |
| Node-API         | `@node-rs/crc32` in the `kitchen` extension             | a prebuilt `.node` loads in the packaged app                                                                                                                         |
| Main thread      | `ctx.runOnMainThread` in the `kitchen` extension        | a native thread-identity call runs on the UI thread, not the JavaScript thread                                                                                       |
| Full-app updater | `checkForAppUpdate` (`denext/desktop/updater`)          | a signed newer manifest is offered; another key, an older version and another app are refused                                                                        |
| Bridge gate      | the token-gated `/_denext/desktop/*` bridge             | a wrong token, a foreign-origin frame holding the token, and the token over plain TCP (the runtime's loopback relay) are all refused, and none reached the extension |
| OS auth session  | `Deno.desktop.authSession`, the `authSession` cap       | macOS: an unattended ephemeral round trip; Windows and Linux: `not_supported`, so `openAuthSession` uses the system browser                                          |
| Auth session     | `openAuthSession` (custom-scheme callback)              | Windows and Linux: the Cancel overlay shows; a forged-`state` callback leaves it pending; the real one completes it, and neither reaches `onDeepLink`                |
| Passkeys         | the `passkeys` capability (`rpIds` pinned)              | an unpinned RP is `invalid_rp` before the OS; the native path answers without a ceremony                                                                             |
| Clerk bridge     | `installClerkDesktopBridge` in the preload              | the token cache is in the keychain, the redirect URL, http: refused, `invalid_rp` turns native passkeys off                                                          |
| Update install   | `downloadAppUpdate`, `installAppUpdateAndRelaunch`      | a copy of the app installs a second signed build (99.0.0); its trial launch is left unconfirmed; the next launch rolls it back and refuses it from then on           |

Not automated: anything that needs a person at the screen (a real drop from the file manager,
dragging a file out, choosing in a native dialog or a context menu, pressing a shortcut, clicking a
notification, a tray icon or a menu, the macOS Automation prompt the first trash asks for, the macOS
login-item approval), a real passkey ceremony (the manual checks above), and an OS code-signature
check of an update between two Developer ID / Authenticode signed builds (the test's builds are
unsigned, so the updater runs with its dev-only `allowUnsignedDev`). The "synthetic" checks dispatch
the OS event on the runtime object that would fire it (through the `kitchen` extension), so
everything from the runtime's event to the page's handler runs. On macOS the first run asks for the
notification permission (answer it once); while it is refused, the scheduling checks are skipped.

## How it's wired

- `denext.config.ts` enables every capability and the pinned-runtime features (`app.origin`,
  `deepLinks`, `singleInstance`, `preload`, window size limits).
- `desktop/kitchen.ts` is the app's own desktop extension (`defineDesktopExtension`). It is the test
  harness: it tells the page whether the runner started it, writes the report, reads files from disk
  so the page can prove the native path ran, loads the Node-API addon and runs the updater checks.
- `e2e/window-test.ts` writes the packaging scripts from the current scaffold template, packages the
  app twice with this OS's script (least-privilege flags; the second build as version 99.0.0 into
  `dist/update/`), serves signed update manifests and the update archive on loopback (a throwaway
  key pair per run, baked into both builds), puts a stand-in system browser first on the app's
  `PATH` (it records the URL and opens nothing), launches the app with a link and a file, starts the
  second instances the page asks for, and checks the report. Then it runs a copy of the app through
  the full-app update (install, an unconfirmed trial launch, the rollback), each launch reporting
  its own checks, and writes `e2e/.run/results.json` (and, in GitHub Actions, the job summary, every
  skip with its reason).
- The runner tells the app it is under test with `kitchen-sink-runner.json` in the app's data folder
  (not the environment), so a process the updater relaunches finds it too.
