# Desktop kitchen sink (every Deno Desktop capability, window-tested)

A denext desktop app that turns on every shipped Deno Desktop capability and calls each one from the
page, plus an automated window test that packages the app, launches it and asserts every result: the
keychain, files, SQLite, device facts, keep-awake, the clipboard (text, HTML, PNG), the shell,
native dialogs, the window API, drag and drop, deep links and opened files, a second instance, the
preload, the stable app origin, a Node-API addon and the full-app updater.

## Run it

```
deno task desktop            # export + open the window (denext's pinned runtime, Deno 2.9.7)
deno task desktop:package    # write scripts/package-*.ts from the scaffold, then package
deno task test:window        # package, launch and assert every check (exits 1 on a failure)
```

Opened by hand, the window lists the checks and runs them on **Run checks**; the launch checks (a
cold-start deep link, a file the OS opens with the app, a link a second launch forwards) and the
updater checks are skipped there, because only the test runner sets them up.

`deno task test:window` needs a display and a desktop session:

- **macOS**: a logged-in session. The clipboard checks put your clipboard text back afterwards.
- **Linux**: a window manager (maximize is a window-manager request on X11) and an unlocked Secret
  Service for `secureStore` (`secret-tool`, from libsecret-tools). Headless, with `XDG_DATA_HOME`
  pointed at a scratch folder so a fresh login keyring is created there and yours is never touched:
  `xvfb-run -a dbus-run-session -- sh -c 'echo -n pw | gnome-keyring-daemon --unlock
  --components=secrets >/dev/null; xfwm4 & deno task test:window'`.
- **Windows**: the interactive desktop session (from SSH, start it from an `/it` scheduled task).

## What each check proves

| Area             | Through                                                 | Asserted                                                                         |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Runtime          | `runtimePlatform()`, `Deno.desktop`                     | a desktop window on denext's pinned runtime                                      |
| App origin       | `desktop.app.origin`                                    | `location.origin` is `kitchensink://app`                                         |
| Bridge events    | the `echo` diagnostic capability                        | an event the runtime pushes reaches the page                                     |
| Preload          | `desktop.preload`                                       | ran before the page's scripts, after the `__denext` global                       |
| `secureStore`    | `secureStore` (`denext/mobile`)                         | the entry is in the OS keychain, then gone                                       |
| `fs`             | `writeFile` / `readFile` / `listDir` / `deleteFile`     | the file is on disk in the data folder                                           |
| `sqlite`         | `openSqlite`                                            | a native `node:sqlite` database, not OPFS                                        |
| `device`         | `deviceInfo`                                            | the runtime's OS and model                                                       |
| `keepAwake`      | the capability's `acquire` / `release`                  | the OS assertion is held and released                                            |
| `clipboard`      | `writeClipboard` / `readClipboard` / `clipboardFormats` | text, HTML and a PNG round trip                                                  |
| `shell`          | `moveToTrash`, `openExternal`                           | an app file goes to the trash; what the config forbids is refused                |
| `dialogs`        | `windowCapabilities().fileDialogs`                      | native dialogs exist; bad arguments are refused before a panel opens             |
| Window           | `denext/desktop/window`                                 | state, screens, size, min/max clamp, maximize, backdrop, a guarded close         |
| Drag and drop    | `onFileDrop`, `startFileDrag`                           | the plumbing: no drag without a held button, no path escapes                     |
| Deep links       | `onDeepLink`, `desktop.app.deepLinks`                   | a cold-start link, and one a second launch forwards (`singleInstance`)           |
| Opened files     | `onOpenFile`                                            | a read-only handle that reads the file and refuses writes                        |
| Node-API         | `@node-rs/crc32` in the `kitchen` extension             | a prebuilt `.node` loads in the packaged app                                     |
| Full-app updater | `checkForAppUpdate` (`denext/desktop/updater`)          | a signed newer manifest is offered; another key and an older version are refused |

Not automated: anything that needs a person at the screen (a real drop from the file manager,
dragging a file out, choosing in a native dialog, the macOS Automation prompt the first trash asks
for) and a full update install, which needs two signed builds.

## How it's wired

- `denext.config.ts` enables every capability and the pinned-runtime features (`app.origin`,
  `deepLinks`, `singleInstance`, `preload`, window size limits).
- `desktop/kitchen.ts` is the app's own desktop extension (`defineDesktopExtension`). It is the test
  harness: it tells the page whether the runner started it, writes the report, reads files from disk
  so the page can prove the native path ran, loads the Node-API addon and runs the updater checks.
- `e2e/window-test.ts` writes the packaging scripts from the current scaffold template, packages the
  app with this OS's script (least-privilege flags), serves signed update manifests on loopback (a
  throwaway key pair per run, baked in at package time), launches the app with a link and a file,
  starts the second instance when the page asks for it, and checks the report.
