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

| File                  | What it is                                                                       |
| --------------------- | -------------------------------------------------------------------------------- |
| `desktop.ts`          | The Deno Desktop entry: `runDesktop`, then hides the window it adopted           |
| `desktop/hangar.ts`   | The backend, a `defineDesktopExtension` the page calls through the bridge        |
| `lib/hangar.ts`       | The VM logic over a `Host` (`lib/host.ts`): library, instances, images, settings |
| `lib/deno-host.ts`    | The real host: `ps`, `lsof` / `/proc`, `qemu-img`, unix sockets, files           |
| `lib/qmp.ts`          | A small QMP client over any byte stream                                          |
| `lib/start-script.ts` | The static `start.sh` reader                                                     |
| `lib/vm-config.ts`    | `hangar.json` validation and its QEMU command line                               |
| `lib/tray.ts`         | The panel's placement at the tray icon and the tray menu                         |
| `app/tray-shell.tsx`  | The tray icon, its clicks and menu, the tooltip, close-to-tray                   |
| `app/window-mode.ts`  | The one window as the panel, a full window, or hidden                            |
| `app/*/`              | The pages: the panel / library, a VM's details, images, a new VM, settings       |

`tests/hangar.test.ts` drives `lib/` against an in-memory host (`tests/helpers/hangar-fake-host.ts`)
and the QMP client against an in-memory socket: no QEMU, no `~/VMs`, no real process.

## What is approximated today

denext's desktop apps have one window and no windowless launch yet, so Hangar approximates a
tray-first app with what exists:

- **Windowless start.** The runtime opens the window at launch; `desktop.ts` hides it as soon as
  `runDesktop` adopted it, so it may flash briefly. The page still loads in the hidden window.
- **The tray is the page's.** `createTray` (`denext/desktop/app`) is called from the page; a full
  reload removes and recreates it. There is no tray before the page loads.
- **The panel is the main window**, resized and moved under the tray icon (`tray.getBounds()`), set
  non-resizable and always on top. It keeps its title bar (no frameless window) and hides on the
  page's `blur` DOM event (denext forwards no window blur event).
- **Full windows are the same window**, resized and navigated: one window at a time.
- **Dock / taskbar icon.** The app shows one, like any other; there is no accessory mode.
- **Clicks.** Left click and double click are told apart; right click opens the menu. No modifier
  keys, no hover. On Linux there are no tray bounds (the panel goes to the top-right corner) and
  most hosts open the menu on any click; stock GNOME needs the AppIndicator extension, and without a
  tray host the runtime shows the window, which Hangar then uses as the full window.
- **Quit.** "Quit" in the tray menu quits; closing the window only hides it (`onCloseRequested`).

Native support for each of these (a windowless launch, no Dock icon, several windows, a backend
tray, richer tray events) is planned in the desktop runtime.
