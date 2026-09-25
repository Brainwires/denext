/**
 * Home-screen widgets for `denext/mobile`: the web side of the `DenextWidgets` plugin that
 * `denext mobile add widget --name <Name>` installs (a WidgetKit extension on iOS, an
 * AppWidgetProvider on Android). The app hands each widget kind a JSON snapshot; the native
 * widget renders it. On the web, and in a shell without the plugin, both functions do nothing
 * (they resolve), so shared code can call them unconditionally.
 *
 * Nothing runs at import.
 *
 * @module
 */

import { nativePlugin } from "./plugin.ts";

/** The JS face of the native plugin (Capacitor seeds a stub per registered method). */
interface WidgetsPlugin {
  setData(
    options: { kind: string; json: string; params?: Record<string, string> },
  ): Promise<unknown>;
  reload(options: { kind?: string }): Promise<unknown>;
}

/** A widget kind: the `--name` it was added with (`Status`), letters first. */
const KIND = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A configurable widget's parameter name or enum value. */
const PARAM = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Options for {@linkcode setWidgetData}. */
export interface SetWidgetDataOptions {
  /**
   * For a configurable widget (`denext mobile add widget --name <kind> --configurable …`): the
   * parameter values this snapshot is for, by parameter name (`{ period: "weekly" }`). A widget
   * the user configured with exactly these values shows it; one with values that have no
   * snapshot of their own shows the snapshot stored without `params`. Android widgets are not
   * configurable and always show the latter.
   */
  readonly params?: Readonly<Record<string, string>>;
}

/** The native plugin, when the shell has it. */
function widgetsPlugin(): WidgetsPlugin | undefined {
  return nativePlugin<WidgetsPlugin>("DenextWidgets", ["setData", "reload"]);
}

/** `params`, checked (names and values are identifiers); undefined when empty. */
function checkParams(params: unknown): Record<string, string> | undefined {
  if (params === undefined) return undefined;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TypeError("setWidgetData: params must be an object of parameter values");
  }
  const checked: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (!PARAM.test(name) || typeof value !== "string" || !PARAM.test(value)) {
      throw new TypeError(
        `setWidgetData: params.${name} must be an enum value such as "weekly" (letters, digits, _)`,
      );
    }
    checked[name] = value;
  }
  return Object.keys(checked).length === 0 ? undefined : checked;
}

/** `kind`, checked; throws a `TypeError` for anything else. */
function checkKind(kind: unknown, fn: string): string {
  if (typeof kind !== "string" || !KIND.test(kind)) {
    throw new TypeError(`${fn}: kind must be a widget name such as "Status"`);
  }
  return kind;
}

/**
 * Store `data` as the snapshot widget `kind` renders, and refresh that kind's widgets.
 *
 * Inside the native shell with the plugin (`denext mobile add widget --name <kind>`): iOS keeps
 * the JSON in the App Group's shared defaults (`denext.widget.<kind>`) and reloads the kind's
 * WidgetKit timelines; Android keeps it in the `denext_widgets` shared preferences and updates
 * the kind's placed widgets. The generated widget shows `title` and `body` strings; edit its
 * view to show more. Elsewhere it does nothing.
 *
 * A configurable widget (iOS 17+) reads the snapshot stored for the values the user chose:
 * store one per combination you want to tailor with `options.params`, and one without `params`
 * as the fallback (and for iOS 14–16 and Android, where widgets are static).
 *
 * @param kind The widget's name (its `--name`).
 * @param data Any JSON-serialisable value (an object for the generated widget).
 * @param options `params`: the configurable widget's parameter values this snapshot is for.
 * @returns A promise that settles once the data is stored. It rejects with a `TypeError` for a
 * bad kind or params or data `JSON.stringify` cannot serialise, and with the native error (code
 * `invalid`, or `unavailable` when the iOS App Group is not set up) otherwise.
 * @example
 * ```ts
 * import { setWidgetData } from "denext/mobile";
 *
 * await setWidgetData("Status", { title: "3 agents running", body: "Last update 12:04" });
 * // A widget added with --configurable period:enum=session|weekly:
 * await setWidgetData("Usage", { title: "Weekly", body: "41% left" }, {
 *   params: { period: "weekly" },
 * });
 * ```
 */
export async function setWidgetData(
  kind: string,
  data: unknown,
  options: SetWidgetDataOptions = {},
): Promise<void> {
  const checked = checkKind(kind, "setWidgetData");
  const params = checkParams(options.params);
  const json = JSON.stringify(data);
  if (json === undefined) {
    throw new TypeError("setWidgetData: data must be a JSON-serialisable value");
  }
  const plugin = widgetsPlugin();
  if (!plugin) return;
  await plugin.setData(
    params === undefined ? { kind: checked, json } : {
      kind: checked,
      json,
      params,
    },
  );
}

/**
 * Ask the OS to redraw widget `kind` (every kind when omitted) from its stored snapshot.
 * Outside the native shell, or without the plugin, it does nothing.
 *
 * @param kind The widget's name; omitted, every widget of the app.
 * @returns A promise that settles once the reload is requested. It rejects with a `TypeError`
 * for a bad kind.
 * @example
 * ```ts
 * import { reloadWidgets } from "denext/mobile";
 *
 * await reloadWidgets(); // e.g. after the user signs out
 * ```
 */
export async function reloadWidgets(kind?: string): Promise<void> {
  const checked = kind === undefined ? undefined : checkKind(kind, "reloadWidgets");
  const plugin = widgetsPlugin();
  if (!plugin) return;
  await plugin.reload(checked === undefined ? {} : { kind: checked });
}
