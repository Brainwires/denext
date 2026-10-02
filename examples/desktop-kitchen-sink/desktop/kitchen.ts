// The kitchen sink's own desktop extension (`desktop.capabilities.extensions`): it runs in the app's
// Deno process, and the page reaches it through the same token-gated bridge as the built-ins
// (`desktopExtension("kitchen")` in `denext/desktop/client`). It is also the window test's harness:
//
// - `setup` tells the page whether it was started by `e2e/window-test.ts` (`KITCHEN_SINK_*` env);
// - `mark` / `report` hand progress markers and the results back to the runner as files;
// - `diskRead` reads a file in the app's data folder straight from disk, so the page can prove a
//   `writeFile` went through the native `fs` capability and not a browser-storage fallback;
// - `crc32` loads a Node-API addon (`@node-rs/crc32`, prebuilt for every desktop OS) in this process;
// - `updateCheck` / `updateStatus` drive `denext/desktop/updater`'s full-app updater;
// - `devtools`, `scheduledTags` read the runtime's DevTools switch and scheduled notifications, and
//   `synthetic` dispatches an OS event (a notification click, a shortcut press, a menu click) on the
//   runtime object that would fire it, for the plumbing no unattended test can press.

import { defineDesktopExtension } from "denext/desktop";
import { appUpdateStatus, checkForAppUpdate } from "denext/desktop/updater";
import { join, resolve, SEPARATOR } from "@std/path";

/** The runner's scratch folder for markers and the report (unset outside the window test). */
function outDir(): string | undefined {
  return Deno.env.get("KITCHEN_SINK_OUT") || undefined;
}

function field(args: unknown, key: string): unknown {
  return typeof args === "object" && args !== null
    ? (args as Record<string, unknown>)[key]
    : undefined;
}

function stringField(args: unknown, key: string): string {
  const value = field(args, key);
  if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
  return value;
}

/** A marker name: letters, digits and dashes only (it becomes a file name). */
function safeName(name: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new TypeError(`bad name ${JSON.stringify(name)}`);
  return name;
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export default defineDesktopExtension({
  name: "kitchen",
  methods: {
    setup: {
      handler: (_args, ctx) => {
        const updateBase = Deno.env.get("KITCHEN_SINK_UPDATE_BASE") || null;
        return {
          autorun: Deno.env.get("KITCHEN_SINK_AUTORUN") === "1",
          // The runner serves signed manifests here: a valid newer one, one signed by another key,
          // and one offering an older version.
          updateUrls: updateBase
            ? {
              good: `${updateBase}good.json`,
              badSignature: `${updateBase}bad-signature.json`,
              downgrade: `${updateBase}downgrade.json`,
            }
            : null,
          os: Deno.build.os,
          target: Deno.build.target,
          // The pinned runtime's `Deno.desktop` (the stock runtime has none).
          pinnedRuntime: typeof (Deno as { desktop?: unknown }).desktop === "object",
          // The fs capability's "data" folder (`moveToTrash` takes an absolute path inside it).
          dataDir: ctx.appSupportDir,
        };
      },
    },
    mark: {
      handler: async (args) => {
        const dir = outDir();
        if (!dir) return { written: false };
        await Deno.writeTextFile(join(dir, `${safeName(stringField(args, "name"))}.marker`), "");
        return { written: true };
      },
    },
    report: {
      handler: async (args, ctx) => {
        const dir = outDir() ?? ctx.appSupportDir;
        const report = {
          at: new Date().toISOString(),
          results: field(args, "results"),
          expected: field(args, "expected"),
        };
        const file = join(dir, "kitchen-sink-report.json");
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(`${file}.tmp`, JSON.stringify(report, null, 2));
        await Deno.rename(`${file}.tmp`, file); // the runner never sees a half-written report
        console.log(`kitchen-sink: report written to ${file}`);
        return { file };
      },
    },
    diskRead: {
      handler: async (args, ctx) => {
        const base = resolve(ctx.appSupportDir);
        const target = resolve(base, stringField(args, "path"));
        if (!target.startsWith(base + SEPARATOR)) {
          throw new TypeError("path escapes the data folder");
        }
        try {
          return { text: await Deno.readTextFile(target) };
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) return { text: null };
          throw err;
        }
      },
    },
    crc32: {
      handler: async (args) => {
        // Loads the platform's prebuilt `.node` (darwin-x64/arm64, linux-x64/arm64-gnu, win32-x64)
        // through Node-API, inside the packaged app. A failure is returned with its message (a
        // packaged app's bridge reports only "the capability failed").
        try {
          const { crc32 } = await import("@node-rs/crc32");
          return { value: crc32(stringField(args, "text")) };
        } catch (err) {
          console.error("kitchen-sink: loading the Node-API addon failed", err);
          return { error: message(err) };
        }
      },
    },
    updateCheck: {
      handler: async (args) => {
        try {
          const result = await checkForAppUpdate({
            manifestUrl: stringField(args, "url"),
            allowInsecureLoopback: true, // the runner's local http server
          });
          return { ok: true, result };
        } catch (err) {
          const e = err as { code?: unknown; message?: unknown };
          return { ok: false, code: String(e.code ?? "unknown"), message: String(e.message) };
        }
      },
    },
    updateStatus: {
      handler: () => appUpdateStatus(),
    },
    devtools: {
      handler: () => ({ enabled: desktop()?.devtools?.enabled ?? null }),
    },
    scheduledTags: {
      handler: async () => {
        const list = await desktop()?.notifications?.getScheduled() ?? [];
        return list.map((n) => n.tag);
      },
    },
    synthetic: {
      handler: (args, ctx) => {
        const kind = stringField(args, "kind");
        const type = stringField(args, "type");
        // Only the three OS events the checks stand in for.
        if (!["notificationresponse", "shortcut", "menuclick"].includes(type)) {
          throw new TypeError(`event ${type} is not one the harness sends`);
        }
        const event = new CustomEvent(type, { detail: field(args, "detail") });
        const target = kind === "desktop"
          ? desktop()
          : kind === "shortcuts"
          ? desktop()?.shortcuts
          : kind === "window"
          ? ctx.window as EventTarget | undefined
          : undefined;
        if (!target) throw new TypeError(`no ${kind} event target in this runtime`);
        target.dispatchEvent(event);
        return { dispatched: true };
      },
    },
  },
});

/** The pinned runtime's `Deno.desktop`, as far as the harness uses it. */
interface DesktopApi extends EventTarget {
  devtools?: { enabled?: boolean };
  notifications?: { getScheduled(): Promise<Array<{ tag: string }>> };
  shortcuts?: EventTarget;
}

function desktop(): DesktopApi | undefined {
  return (Deno as unknown as { desktop?: DesktopApi }).desktop;
}
