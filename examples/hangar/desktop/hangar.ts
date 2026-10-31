// Hangar's backend as a desktop extension (`desktop.capabilities.extensions`): it runs in the app's
// Deno process and the page reaches it through the token-gated bridge
// (`desktopExtension("hangar")`, wrapped by `app/hangar-client.ts`). Each method checks its
// arguments and hands them to `lib/hangar.ts`, which does the work over the real machine
// (`lib/deno-host.ts`). Errors reach the page as a code and a message without absolute paths.

import { defineDesktopExtension, DesktopCapError } from "denext/desktop";
import { join } from "@std/path/posix";
import { denoHost } from "../lib/deno-host.ts";
import type { HangarWindows } from "../lib/tray-driver.ts";
import {
  createHangar,
  defaultSettings,
  type Hangar,
  HangarError,
  parseSettings,
} from "../lib/hangar.ts";

/** The settings file, in the app's data folder. */
const SETTINGS_FILE = "hangar-settings.json";

let instance: Promise<Hangar> | undefined;

/** The backend, created once with the saved settings. */
function hangar(appSupportDir: string): Promise<Hangar> {
  instance ??= (async () => {
    const host = denoHost();
    const base = defaultSettings(host.home, host.os);
    let saved: unknown = {};
    try {
      saved = JSON.parse(await Deno.readTextFile(join(appSupportDir, SETTINGS_FILE)));
    } catch { /* first launch, or an unreadable file: the defaults */ }
    let settings = base;
    try {
      settings = parseSettings(saved, base);
    } catch { /* a hand-edited bad value: the defaults */ }
    return createHangar(host, settings);
  })();
  return instance;
}

/**
 * The backend for desktop.ts (the tray driver), the same instance the pages reach. `appSupportDir`
 * is the one the bridge hands the methods (`runDesktop({ appSupportDir })`).
 */
export function hangarBackend(appSupportDir = ""): Promise<Hangar> {
  return hangar(appSupportDir);
}

let windows: HangarWindows | undefined;

/** Hand the methods desktop.ts's window manager (`open` opens every full window through it). */
export function setHangarWindows(manager: HangarWindows): void {
  windows = manager;
}

/** The page's arguments as an object (the bridge passes JSON). */
function args(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new DesktopCapError("validation", `${field} is required`);
  }
  return value;
}

/** Run `fn` against the backend, turning Hangar's refusals into bridge errors. */
async function call<T>(
  dir: string,
  fn: (h: Hangar) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await hangar(dir));
  } catch (err) {
    if (err instanceof HangarError) throw new DesktopCapError(err.code, err.message);
    if (err instanceof DesktopCapError) throw err;
    console.error("hangar:", err);
    throw new DesktopCapError("failed", "The action failed; see the app's log");
  }
}

/** A method whose handler gets the page's arguments and the backend. */
function method<T>(
  fn: (a: Record<string, unknown>, h: Hangar) => Promise<T>,
  timeoutMs?: number | false,
) {
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    handler: (raw: unknown, ctx: { appSupportDir: string }) =>
      call(ctx.appSupportDir, (h) => fn(args(raw), h)),
  };
}

const ACTIONS = ["create", "apply", "delete"] as const;

export default defineDesktopExtension({
  name: "hangar",
  methods: {
    overview: method((_a, h) => h.overview()),
    status: method((a, h) => h.status(str(a.id, "id"))),
    start: method((a, h) =>
      h.start(str(a.id, "id"), {
        headless: a.headless === true,
        allowOverBudget: a.allowOverBudget === true,
      })
    ),
    // A graceful shutdown waits for the guest (up to the configured timeout, then QMP `quit`).
    shutdown: method((a, h) => h.shutdown(str(a.id, "id")), false),
    forceStop: method((a, h) => h.forceStop(str(a.id, "id"), Number(a.pid), String(a.confirm))),
    images: method((a, h) => h.images(a.id === undefined ? undefined : str(a.id, "id"))),
    imageInfo: method((a, h) => h.imageInfo(str(a.id, "id"), str(a.file, "file"))),
    createImage: method((a, h) =>
      h.createImage(
        str(a.id, "id"),
        str(a.file, "file"),
        str(a.size, "size"),
        a.format as "qcow2",
      )
    ),
    resizeImage: method((a, h) =>
      h.resizeImage(str(a.id, "id"), str(a.file, "file"), str(a.size, "size"))
    ),
    // Converting a large disk takes minutes.
    convertImage: method(
      (a, h) =>
        h.convertImage(
          str(a.id, "id"),
          str(a.file, "file"),
          str(a.target, "target"),
          a.format as "qcow2",
        ),
      false,
    ),
    snapshot: method((a, h) => {
      if (!ACTIONS.includes(a.action as typeof ACTIONS[number])) {
        throw new DesktopCapError("validation", "action must be create, apply or delete");
      }
      return h.snapshot(
        str(a.id, "id"),
        str(a.file, "file"),
        a.action as typeof ACTIONS[number],
        str(a.name, "name"),
        typeof a.confirm === "string" ? a.confirm : undefined,
      );
    }, 120_000),
    deleteImage: method((a, h) =>
      h.deleteImage(str(a.id, "id"), str(a.file, "file"), String(a.confirm))
    ),
    createVm: method(
      (a, h) => h.createVm(str(a.id, "id"), a.config, str(a.diskSize, "diskSize")),
      120_000,
    ),
    openTerminal: method((a, h) => h.openTerminal(str(a.id, "id"))),
    // A page in a full window of its own (`"/"`: the library, the main window), through the window
    // manager desktop.ts owns, so the panel's buttons and the tray's menu share one window per page.
    open: {
      handler: (raw: unknown) => {
        const path = str(args(raw).path, "path");
        if (!/^\/(?![/\\])/.test(path)) {
          throw new DesktopCapError("validation", 'path must be a path of the app, like "/images"');
        }
        if (!windows) throw new DesktopCapError("unavailable", "no window manager in this launch");
        windows.openFull(path);
        return null;
      },
    },
    getSettings: method((_a, h) => Promise.resolve(h.settings())),
    setSettings: {
      handler: (raw: unknown, ctx: { appSupportDir: string }) =>
        call(ctx.appSupportDir, async (h) => {
          const next = parseSettings(raw, h.settings());
          await Deno.mkdir(ctx.appSupportDir, { recursive: true });
          await Deno.writeTextFile(
            join(ctx.appSupportDir, SETTINGS_FILE),
            JSON.stringify(next, null, 2) + "\n",
          );
          h.setSettings(next);
          return next;
        }),
    },
  },
});
