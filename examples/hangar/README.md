# Hangar (a tray-first desktop app for QEMU VMs)

A denext desktop app that lives in the tray / menu bar and manages QEMU disk images and running VM
instances: a panel at the tray icon on left click, a menu on right click (the running VMs, start
headless, shut down), and full windows on demand for a VM's details, the images and the settings.
Closing the window leaves it running in the tray, and the tray tooltip shows how many VMs run and
the RAM they use. The VM logic is plain Deno code over a fake-able host, tested without QEMU.

## Run it

```sh
denext task desktop            # export + open the app (denext's pinned Deno Desktop runtime)
denext task desktop:package    # write scripts/package-*.ts from the scaffold, then package
denext task dev                # the UI in a browser (no backend: it says so)
```

It needs QEMU (`brew install qemu` on macOS; `qemu-system-*` and `qemu-img` on the `PATH` prefix set
in Settings, `/opt/homebrew` by default). The tests run from the repository root:

```sh
deno test -A tests/hangar.test.ts
```

## What it does

- **VM library.** Every folder under `~/VMs` (Settings → library folder) with a `start.sh` is
  adopted as is: Hangar reads the script without running it (QEMU binary, `-name`, `-m`, `-smp`,
  accelerator, disks, QMP socket, forwarded ports, and whether it honours `LAB_HEADLESS=1` for a
  headless, daemonized start with a pidfile). VMs Hangar creates get a `hangar.json` instead of a
  script (architecture, `hvf` / `tcg`, CPUs, memory, disks, an installer ISO to boot from once,
  forwarded ports, display `none` / `cocoa`), and Hangar builds their QEMU command line itself.
- **Instances.** A running VM is a `qemu-system-*` process whose working directory is the VM's
  folder (or, where that cannot be read, the pid in its pidfile), never a match on `-name`. Start
  headless or with a window, shut down gracefully (QMP `system_powerdown`, then QMP `quit` after the
  timeout), force stop by the exact pid shown, live QMP `query-status`, RAM and CPU per VM, a RAM
  budget (a share of host memory; starting a VM over it asks first), and ssh / Remote Desktop quick
  actions (copy the command, or open it in Terminal on macOS).
- **Images.** The images in each VM folder: `qemu-img info`, create, grow, convert, and internal
  snapshots (list, create, apply, delete). Disk changes are refused while the VM runs.
- **Safety.** Deleting an image, applying or deleting a snapshot and force stopping take a confirm
  step (type the name), which the backend checks again. Every action names a library VM by id; a
  path must stay inside that VM's folder (symlinks resolved). Hangar reads only `start.sh` and
  `hangar.json` in a VM folder; of the other files it sees names and sizes, never their contents.

## How it is built

| File                  | What it is                                                                        |
| --------------------- | --------------------------------------------------------------------------------- |
| `desktop.ts`          | The Deno Desktop entry: `runDesktop` with the config's window, tray and Dock      |
| `desktop/hangar.ts`   | The backend, a `defineDesktopExtension` the page calls through the bridge         |
| `lib/hangar.ts`       | The VM logic over a `Host` (`lib/host.ts`): library, instances, images, settings  |
| `lib/deno-host.ts`    | The real host: `ps`, `lsof` / `/proc`, `qemu-img`, unix sockets, files            |
| `lib/qmp.ts`          | A small QMP client over any byte stream                                           |
| `lib/start-script.ts` | The static `start.sh` reader                                                      |
| `lib/vm-config.ts`    | `hangar.json` validation and its QEMU command line                                |
| `lib/tray.ts`         | The window sizes and the tray menu                                                |
| `app/tray-shell.tsx`  | The main page drives the backend tray: menu, tooltip, double click, close-to-tray |
| `app/window-mode.ts`  | The panel, the main window (the library) and one window per other page            |
| `app/*/`              | The pages: the library, the panel, a VM's details, images, a new VM, settings     |

`tests/hangar.test.ts` drives `lib/` against an in-memory host (`tests/helpers/hangar-fake-host.ts`)
and the QMP client against an in-memory socket: no QEMU, no `~/VMs`, no real process.

## How it is tray-first

Everything below comes from denext's desktop windowing (`denext.config.ts`, `desktop.*`):

- **Windowless start.** `desktop.window.show: false`: the main window (the library) starts hidden,
  with no flash; its page still loads and drives the tray's menu and tooltip.
- **No Dock icon.** `desktop.app.activationPolicy: "accessory"` (macOS): no Dock icon or menu bar
  from the first frame. `app/window-mode.ts` switches to `setActivationPolicy("regular")` while a
  full window is open, so it comes to the front and Cmd-Tab reaches it, and back to `"accessory"`
  after.
- **A backend tray.** `desktop.tray` is created by `runDesktop` before any page loads and survives
  reloads; pages reach it with `getTray()` (`denext/desktop/app`).
- **A real panel.** `desktop.tray.panel` is the runtime's `Tray.attachPanel`: a frameless window
  that never takes the focus, toggled by a plain left click, hidden when it loses the focus, and
  placed by denext under a menu-bar icon or above a bottom taskbar, inside the display's work area.
- **The tray's clicks.** A right click opens the menu (the OS does); a Control-click opens it too
  (`popUpMenu()` in `desktop.ts`, for a one-button mouse); a double click opens the library; the
  tooltip is refreshed as soon as the pointer is over the icon (`tray.on("mouseenter")` in
  `app/tray-shell.tsx`, macOS and Windows), and every few seconds.
- **Several windows.** "Images", "New VM", "Settings" and a VM's details each open in a window of
  their own (`openWindow` in `denext/desktop/window`); "Open Hangar" shows the main window.
- **Keep alive.** `desktop.app.keepAlive`: closing every window leaves Hangar in the tray; closing
  the main window hides it (`onCloseRequested`), so its page keeps the tray current. "Quit" quits.

What depends on the OS: hover and `popUpMenu()` are macOS and Windows only; on Linux a session
with a StatusNotifierWatcher gets the clicks, one with only AppIndicator has no left click and no
icon position (the panel opens where it last was; the menu has "Show panel"), and stock GNOME needs
the AppIndicator extension (without a tray host the main window is shown instead). On a runtime
before 3.0.0-denext.6 the Dock icon shows for a moment at launch and the tray's clicks carry no
detail.
