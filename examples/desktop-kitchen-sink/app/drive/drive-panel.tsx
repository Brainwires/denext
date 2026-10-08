"use client";
// The drive mode's driver (see `protocol.ts`): takes the queue's commands one at a time through the
// `kitchen` extension, runs each through the same public APIs an app uses, and writes its answer;
// tray clicks, notification taps, deep links, title bar changes and window state changes are
// written as events as they happen. Every line is also shown on the page.

import { useEffect, useState } from "denext";
import {
  onDeepLink,
  onLocalNotificationTapped,
  pickDocument,
  pickFolder,
  saveFile,
  scheduleNotification,
  secureStore,
} from "denext/mobile";
import { appCapabilities, type AppTray, createTray } from "denext/desktop/app";
import { desktopExtension } from "denext/desktop/client";
import {
  focusWindow,
  getTitleBarPreferences,
  getWindowState,
  maximizeWindow,
  minimizeWindow,
  onTitleBarPreferencesChange,
  onWindowStateChange,
  quitApp,
  restoreWindow,
  setFullScreen,
  setWindowSize,
  unmaximizeWindow,
} from "denext/desktop/window";
import { describeError, probeFacts } from "../facts.ts";
import { DRIVE_COMMANDS, type DriveCommand, type DriveEvent } from "./protocol.ts";

const kitchen = desktopExtension("kitchen") as unknown as Record<
  string,
  (args?: unknown) => Promise<unknown>
>;

/** A visible 16x16 tray icon (an orange square), base64 PNG. */
const TRAY_ICON =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR42mNgGDTgWYDcf1LwqAGjBgxXAwYMAAD6UU7ATXQUYAAAAABJRU5ErkJggg==";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the commands share across the queue loop. */
interface Drive {
  readonly event: (event: DriveEvent["event"], data: unknown) => void;
  tray: AppTray | null;
  stopTray: (() => void) | null;
  stopTitleBar: (() => void) | null;
  readonly deepLinks: string[];
}

/** Run a window action, let the window manager settle, then report the window's state. */
async function windowAction(action: () => Promise<unknown>): Promise<unknown> {
  const applied = await action();
  await sleep(700);
  return { applied: applied ?? null, state: await getWindowState() };
}

const num = (args: DriveCommand["args"], key: string) => {
  const v = args?.[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`${key} must be a number`);
  return v;
};
const str = (args: DriveCommand["args"], key: string, fallback: string) => {
  const v = args?.[key];
  return typeof v === "string" ? v : fallback;
};

const COMMANDS: Record<string, (drive: Drive, args: DriveCommand["args"]) => Promise<unknown>> = {
  help: () => Promise.resolve(DRIVE_COMMANDS),
  probe: () => probeFacts(),
  titlebar: () => getTitleBarPreferences(),
  "titlebar-watch": (drive) => {
    drive.stopTitleBar ??= onTitleBarPreferencesChange((p) => drive.event("TITLEBAR", p));
    return Promise.resolve("watching");
  },
  state: () => getWindowState(),
  maximize: () => windowAction(maximizeWindow),
  unmaximize: () => windowAction(unmaximizeWindow),
  minimize: () => windowAction(minimizeWindow),
  restore: () => windowAction(restoreWindow),
  focus: () => windowAction(focusWindow),
  "fullscreen-on": () => windowAction(() => setFullScreen(true)),
  "fullscreen-off": () => windowAction(() => setFullScreen(false)),
  size: (_drive, args) =>
    windowAction(() => setWindowSize(num(args, "width"), num(args, "height"))),
  secure: async () => {
    const key = `drive-${Date.now()}`;
    const value = `value-${crypto.randomUUID()}`;
    const steps: Record<string, unknown> = { key };
    const step = async (name: string, run: () => Promise<unknown>) => {
      try {
        steps[name] = { ok: true, result: (await run()) ?? null };
      } catch (err) {
        steps[name] = { ok: false, error: describeError(err) };
      }
    };
    await step("set", () => secureStore.set(key, value));
    await step("get", async () => ({ matches: (await secureStore.get(key)) === value }));
    await step("delete", () => secureStore.delete(key));
    await step("get-after-delete", () => secureStore.get(key));
    const ok = ["set", "get", "delete", "get-after-delete"].every((k) =>
      (steps[k] as { ok: boolean }).ok
    );
    if (!ok) throw new Error(`secureStore: ${JSON.stringify(steps)}`);
    return steps;
  },
  notify: async (_drive, args) => ({
    id: await scheduleNotification({
      title: str(args, "title", "Drive mode"),
      body: str(args, "body", "click me"),
      data: { drive: true },
    }),
  }),
  "tray-on": async (drive) => {
    if (drive.tray) await COMMANDS["tray-off"](drive, undefined);
    const caps = await appCapabilities();
    const tray = await createTray({
      icon: TRAY_ICON,
      tooltip: "denext drive mode",
      menu: [{ id: "ping", label: "Ping" }, "separator", { id: "quit-drive", label: "Quit" }],
    });
    drive.tray = tray;
    const stopMenu = tray.onMenuItem((id) => {
      drive.event("TRAY", { menuItem: id });
      if (id === "quit-drive") void quitApp();
    });
    const stopClick = tray.onClick((click) => drive.event("TRAY", { click }));
    drive.stopTray = () => {
      stopMenu();
      stopClick();
    };
    await sleep(300);
    const bounds = await tray.getBounds().catch((err) => ({ error: describeError(err) }));
    return { id: tray.id, bounds, trayHost: caps.trayHost, trayReason: caps.trayReason ?? null };
  },
  "tray-off": async (drive) => {
    if (!drive.tray) return { destroyed: false, reason: "no tray" };
    drive.stopTray?.();
    const tray = drive.tray;
    drive.tray = null;
    drive.stopTray = null;
    await tray.destroy();
    return { destroyed: true };
  },
  "open-dialog": async () => {
    const doc = await pickDocument();
    return doc ? { ...doc, data: undefined } : { cancelled: true };
  },
  "save-dialog": async () => {
    const saved = await saveFile(`drive mode ${new Date().toISOString()}\n`, {
      suggestedName: "kitchen-sink-drive.txt",
      types: ["text/plain"],
    });
    return saved ? { name: saved.name, path: saved.path ?? null } : { cancelled: true };
  },
  "folder-dialog": async () => {
    const folder = await pickFolder();
    return folder ? { name: folder.name, path: folder.path ?? null } : { cancelled: true };
  },
  "native-dialog": (_drive, args) =>
    kitchen.nativeDialog({
      kind: str(args, "kind", "open"),
      ...(typeof args?.cancelAfterMs === "number" ? { cancelAfterMs: args.cancelAfterMs } : {}),
    }),
  deeplinks: (drive) => Promise.resolve({ count: drive.deepLinks.length, urls: drive.deepLinks }),
  quit: () => {
    // Answer first: the result must be written before the app is gone.
    setTimeout(() => void quitApp(), 300);
    return Promise.resolve({ quitting: true });
  },
};

type Next = { command: DriveCommand } | { id: string; error: string } | null;

export function DrivePanel() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    let stopped = false;
    const show = (line: string) =>
      setLines((prev) => [...prev.slice(-499), `${new Date().toISOString()} ${line}`]);
    // Events are written in order: each waits for the one before.
    let writes = Promise.resolve();
    const drive: Drive = {
      event: (event, data) => {
        show(`${event} ${JSON.stringify(data)}`);
        writes = writes.then(() => kitchen.driveEvent({ event, data })).then(
          () => {},
          (err) => console.error("drive: writing an event failed", err),
        );
      },
      tray: null,
      stopTray: null,
      stopTitleBar: null,
      deepLinks: [],
    };
    const stopLinks = onDeepLink((link) => {
      drive.deepLinks.push(link.url);
      drive.event("DEEPLINK", link.url);
    }, { route: false });
    const stopTaps = onLocalNotificationTapped((tap) => drive.event("TAPPED", tap), {
      route: false,
    });
    const stopState = onWindowStateChange((state) => drive.event("WINDOW", state));

    const answer = async (id: string, cmd: string, started: number, outcome: object) => {
      const result = {
        id,
        cmd,
        ...outcome,
        at: new Date().toISOString(),
        ms: Math.round(performance.now() - started),
      };
      show(`${"error" in outcome ? "ERR" : "OK"} ${cmd} ${JSON.stringify(result)}`);
      await kitchen.driveResult({ id, result });
    };

    const run = async (next: NonNullable<Next>) => {
      const started = performance.now();
      if (!("command" in next)) {
        return answer(next.id, "", started, { ok: false, error: next.error });
      }
      const { id, cmd, args } = next.command;
      show(`> ${cmd} ${args ? JSON.stringify(args) : ""}`);
      const command = COMMANDS[cmd];
      if (!command) {
        const known = Object.keys(COMMANDS).join(", ");
        return answer(id, cmd, started, { ok: false, error: `unknown command (${known})` });
      }
      try {
        await answer(id, cmd, started, { ok: true, result: (await command(drive, args)) ?? null });
      } catch (err) {
        await answer(id, cmd, started, { ok: false, error: describeError(err) });
      }
    };

    void (async () => {
      await kitchen.driveReady({ href: location.href }).catch((err) =>
        show(`ERR ready ${describeError(err)}`)
      );
      show("READY");
      while (!stopped) {
        let next: Next = null;
        try {
          next = await kitchen.driveNext({}) as Next;
        } catch (err) {
          show(`ERR driveNext ${describeError(err)}`);
          await sleep(1000);
        }
        if (next) await run(next);
        else await sleep(250);
      }
    })();

    return () => {
      stopped = true;
      stopLinks();
      stopTaps();
      stopState();
      drive.stopTray?.();
      drive.stopTitleBar?.();
    };
  }, []);

  return <pre id="drive-log" class="manual-result">{lines.join("\n")}</pre>;
}
