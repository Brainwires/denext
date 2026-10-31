// The native halves of denext's home-screen widgets and Live Activities, embedded as text so
// they ship inside the JSR package: `denext mobile add widget --name <Name>` and
// `denext mobile add live-activity --name <Name>` write them into a Capacitor project.
//
// - iOS: `ios/App/DenextWidgets/`, a WidgetKit extension target holding every widget
//   (`<Name>Widget.swift`; with `--configurable`, an App Intents configuration on iOS 17+ and a
//   static fallback before), every Live Activity UI (`<Name>LiveActivity.swift`, dispatched by
//   `DenextLiveActivities.swift`), the bundle that lists them (`DenextWidgetsBundle.swift`), the
//   snapshot reader (`DenextWidgetStore.swift`) and the ActivityKit attributes
//   (`DenextActivityAttributes.swift`, which the App target compiles too). App side:
//   `DenextWidgetsPlugin.swift` (setWidgetData / reloadWidgets) and
//   `DenextLiveActivityPlugin.swift` (start / update / end / list, push and push-to-start
//   tokens and their events).
// - Android: `dev/denext/widgets/DenextWidgetsPlugin.java`, one `<Name>Widget.java`
//   AppWidgetProvider per widget with its RemoteViews layout and appwidget-provider XML.
//
// The per-name files are the app's to edit (the marker keeps an edited one); the bundle and the
// Live Activity dispatcher are composed from the names found in the extension folder and are
// rewritten while unedited. The same marker family and version as app-extension-native-templates.ts.
//
// The template texts ship packed: native-templates/widget.ts and native-templates/widget-sources.ts
// (the readable sources, not published; the per-name files there have `{{=name}}` holes this
// module fills) are packed with the others into the docs-corpus pack by `deno task
// gen:native-templates`.

import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";
import { fillTemplate } from "./packed-text.ts";
import { HEADER } from "./widget-template-header.ts";

/** The per-name sources' texts (readable source: native-templates/widget-sources.ts). */
const SOURCES = NATIVE_TEMPLATES.widgetSources.WIDGET_SOURCE_TEMPLATES;

/** The widget extension's target (and folder, under `ios/App/`). */
export const WIDGETS_TARGET = "DenextWidgets";

/** The widget extension's `NSExtension` dict. */
export const WIDGET_EXTENSION_ATTRIBUTES = `		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.widgetkit-extension</string>
`;

/** A widget / Live Activity name: a Swift and Java type name (`Status`, `OrderProgress`). */
export const EXTENSION_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

/** `OrderProgress` → `order_progress` (Android resource names). */
export function snakeName(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Swift sources for `ios/App/DenextWidgets/` every widget extension has, keyed by file name. */
export const WIDGETS_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.widget.WIDGETS_IOS_FILES;

/**
 * `DenextWidgetsBundle.swift`: the extension's entry point listing `widgets` (names) and, with
 * `liveActivities`, the Live Activity configuration (iOS 16.1 and later). A configurable widget
 * also lists its App Intents widget (`<Name>ConfigurableWidget`, iOS 17 and later): a
 * WidgetBundleBuilder takes `if #available` without `else`, so the static `<Name>Widget` stays
 * listed and hides itself on iOS 17 (no supported families).
 *
 * @param widgets The widget names.
 * @param liveActivities Whether any Live Activity UI is installed.
 * @param configurable The widget names that are configurable (a subset of `widgets`).
 * @returns The template (without its marker).
 */
export function widgetsBundleSource(
  widgets: readonly string[],
  liveActivities: boolean,
  configurable: readonly string[] = [],
): string {
  const lines = widgets.map((name) => `        ${name}Widget()\n`);
  if (configurable.length > 0) {
    lines.push(
      "        if #available(iOSApplicationExtension 17.0, *) {\n",
      ...configurable.map((name) => `            ${name}ConfigurableWidget()\n`),
      "        }\n",
    );
  }
  if (liveActivities) {
    lines.push(
      "        if #available(iOSApplicationExtension 16.1, *) {\n",
      "            DenextLiveActivities()\n",
      "        }\n",
    );
  }
  if (lines.length === 0) lines.push("        DenextEmptyWidget()\n");
  const empty = widgets.length === 0 && !liveActivities
    ? String.raw`
/// A placeholder while the extension has no widget (WidgetBundle needs one).
struct DenextEmptyWidget: Widget {
    var body: some WidgetConfiguration {
        EmptyWidgetConfiguration()
    }
}
`
    : "";
  return HEADER("widget / live-activity", false) +
    String
      .raw`// Rewritten while unedited whenever a widget or Live Activity is added; if you edit it, list new
// ones in body yourself.

import SwiftUI
import WidgetKit

/// The widget extension's entry point: every widget and the Live Activity UI.
@main
struct DenextWidgetsBundle: WidgetBundle {
    var body: some Widget {
${lines.join("")}    }
}
${empty}`;
}

/**
 * `<Name>Widget.swift`: a static widget whose timeline shows the JSON `setWidgetData(name, …)`
 * stored (`title` and `body` strings, as a starting point).
 *
 * @param name The widget name (also its kind).
 * @returns The template (without its marker).
 */
export function widgetSource(name: string): string {
  return HEADER("widget", true) + fillTemplate(SOURCES["Widget.swift"], { name });
}

/** One enum parameter of a configurable widget (`--configurable period:enum=day|week`). */
export interface WidgetParam {
  /** The parameter name (a lowerCamelCase identifier): the key in `setWidgetData`'s params. */
  readonly name: string;
  /** Its values, in order; the first is the default. */
  readonly values: readonly string[];
}

/** A configurable widget parameter's name. */
const PARAM_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
/** A value of an enum parameter (a Swift enum case). */
const PARAM_VALUE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** The comment a configurable widget's source records its parameters in. */
const PARAMS_LINE = /^\/\/ denext-widget-configurable: (.+)$/m;

/**
 * Parse `--configurable` items (`<param>:enum=<a|b|c>`, the flag's comma-separated list) into
 * widget parameters; throws on anything else.
 *
 * @param items The items.
 * @returns The parameters, in order.
 */
export function parseWidgetParams(items: readonly string[]): WidgetParam[] {
  const params: WidgetParam[] = [];
  for (const item of items) {
    const m = /^([^:=]*):([^=]*)=(.*)$/.exec(item.trim());
    if (!m) {
      throw new Error(
        `--configurable ${item}: expected <param>:enum=<a|b|c>, e.g. period:enum=day|week.`,
      );
    }
    const [, name, type, list] = m;
    if (!PARAM_NAME.test(name)) {
      throw new Error(
        `--configurable ${item}: a parameter name is a lowerCamelCase identifier (e.g. period).`,
      );
    }
    if (name === "params") {
      throw new Error(
        `--configurable ${item}: "params" is reserved (the intent's map of chosen values).`,
      );
    }
    if (type !== "enum") {
      throw new Error(
        `--configurable ${item}: only enum parameters are supported (${name}:enum=…).`,
      );
    }
    const values = list.split("|").map((v) => v.trim());
    const bad = values.find((v) => !PARAM_VALUE.test(v));
    if (bad !== undefined) {
      throw new Error(
        `--configurable ${item}: "${bad}" is not an enum value (letters, digits and _, starting ` +
          "with a letter).",
      );
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`--configurable ${item}: a value is listed twice.`);
    }
    if (params.some((p) => p.name === name)) {
      throw new Error(`--configurable: parameter ${name} is given twice.`);
    }
    params.push({ name, values });
  }
  return params;
}

/**
 * Widget parameters in `--configurable` form (`a:enum=x|y,b:enum=z`).
 *
 * @param params The parameters.
 * @returns The text.
 */
export function formatWidgetParams(params: readonly WidgetParam[]): string {
  return params.map((p) => `${p.name}:enum=${p.values.join("|")}`).join(",");
}

/**
 * The parameters a configurable widget's source records, or undefined for a static widget.
 *
 * @param source A `<Name>Widget.swift`.
 * @returns The parameters.
 */
export function widgetParamsIn(source: string): WidgetParam[] | undefined {
  const line = PARAMS_LINE.exec(source)?.[1];
  if (line === undefined) return undefined;
  try {
    return parseWidgetParams(line.split(","));
  } catch {
    return undefined;
  }
}

/** `codexPeriod` / `session_long` → `Codex Period` / `Session Long`. */
function titleOf(identifier: string): string {
  return identifier.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}

/** A Swift identifier in backticks, so a keyword (`default`) is a plain name. */
const ticked = (identifier: string) => "`" + identifier + "`";

/**
 * `<Name>Widget.swift` for a configurable widget: on iOS 17 and later an App Intents
 * `WidgetConfigurationIntent` with one enum per parameter, whose provider reads the snapshot
 * `setWidgetData(name, data, { params })` stored for the chosen values (the one stored without
 * params when there is none); on iOS 14–16 a static configuration showing the defaults' snapshot.
 *
 * @param name The widget name (the iOS 17 widget's kind; the static one's is `<name>.static`).
 * @param params The enum parameters (at least one).
 * @returns The template (without its marker).
 */
export function configurableWidgetSource(name: string, params: readonly WidgetParam[]): string {
  const enumName = (p: WidgetParam) => `${name}${p.name[0].toUpperCase()}${p.name.slice(1)}Option`;
  const enums = params.map((p) => {
    const cases = p.values.map((v) => `    case ${ticked(v)}\n`).join("");
    const shown = p.values.map((v) => `        .${ticked(v)}: "${titleOf(v)}",\n`).join("");
    return `/// The ${p.name} parameter's values.
@available(iOS 17.0, *)
enum ${enumName(p)}: String, AppEnum {
${cases}
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "${titleOf(p.name)}"
    static let caseDisplayRepresentations: [${enumName(p)}: DisplayRepresentation] = [
${shown}    ]
}
`;
  }).join("\n");
  const fields = params.map((p) =>
    `    @Parameter(title: "${titleOf(p.name)}", default: .${ticked(p.values[0])})
    var ${ticked(p.name)}: ${enumName(p)}
`
  ).join("\n");
  const chosen = params.map((p) => `            "${p.name}": ${ticked(p.name)}.rawValue,\n`)
    .join("");
  const defaults = params.map((p) => `        "${p.name}": "${p.values[0]}",\n`).join("");
  return HEADER("widget", true) + `// denext-widget-configurable: ${formatWidgetParams(params)}
// (re-running \`denext mobile add widget --name ${name}\` without --configurable keeps these).
` + fillTemplate(SOURCES["ConfigurableWidget.swift"], { name, defaults, enums, fields, chosen });
}

/** The ActivityKit attributes both the App and the widget extension compile. */
export const LIVE_ACTIVITY_SHARED_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.widget.LIVE_ACTIVITY_SHARED_FILES;

/**
 * `DenextLiveActivities.swift`: the one ActivityConfiguration for `DenextActivityAttributes`,
 * dispatching on the activity's name to each `<Name>LiveActivity`.
 *
 * @param names The Live Activity names.
 * @returns The template (without its marker).
 */
export function liveActivitiesSource(names: readonly string[]): string {
  const lock = names.map((n) => `            case "${n}": ${n}LiveActivity.lockScreen(context)\n`);
  const island = names.map((n) =>
    `        case "${n}": return ${n}LiveActivity.dynamicIsland(context)\n`
  );
  return HEADER("live-activity", false) +
    fillTemplate(SOURCES["LiveActivities.swift"], { lock: lock.join(""), island: island.join("") });
}

/**
 * `<Name>LiveActivity.swift`: the Lock Screen and Dynamic Island UI of Live Activity `name`
 * (state `title`, `body` and `progress` from 0 to 1, as a starting point).
 *
 * @param name The Live Activity name.
 * @returns The template (without its marker).
 */
export function liveActivitySource(name: string): string {
  return HEADER("live-activity", true) + fillTemplate(SOURCES["LiveActivity.swift"], { name });
}

/** App-side plugins for `ios/App/App/`, keyed by file name. */
export const WIDGETS_PLUGIN_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.widget.WIDGETS_PLUGIN_IOS_FILES;

/** The Live Activity plugin for `ios/App/App/`. */
export const LIVE_ACTIVITY_PLUGIN_IOS_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.widget.LIVE_ACTIVITY_PLUGIN_IOS_FILES;

/** The Android widgets plugin for `dev/denext/widgets/`. */
export const WIDGETS_ANDROID_FILES: Readonly<Record<string, string>> =
  NATIVE_TEMPLATES.widget.WIDGETS_ANDROID_FILES;

/**
 * `<Name>Widget.java`: the AppWidgetProvider for widget `name`, showing the stored `title` and
 * `body`, opening the app on tap.
 *
 * @param name The widget name.
 * @param rPackage The app's resource (`R`) package: its Gradle `namespace`.
 * @returns The template (without its marker).
 */
export function androidWidgetSource(name: string, rPackage: string): string {
  const res = snakeName(name);
  return HEADER("widget", true) + fillTemplate(SOURCES["Widget.java"], { name, rPackage, res });
}

/**
 * `res/layout/denext_widget_<name>.xml`: the widget's RemoteViews layout.
 *
 * @returns The template (without its marker; an XML file).
 */
export function androidWidgetLayout(): string {
  return SOURCES["widget_layout.xml"];
}

/**
 * `res/xml/denext_widget_<name>_info.xml`: the appwidget-provider (size, resize, layout).
 *
 * @param name The widget name.
 * @returns The template (without its marker; an XML file).
 */
export function androidWidgetInfo(name: string): string {
  const res = snakeName(name);
  return `<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:initialLayout="@layout/denext_widget_${res}"
    android:minWidth="110dp"
    android:minHeight="40dp"
    android:resizeMode="horizontal|vertical"
    android:targetCellWidth="2"
    android:targetCellHeight="1"
    android:updatePeriodMillis="0"
    android:widgetCategory="home_screen" />
`;
}

/**
 * The manifest `<receiver>` for widget `name`, as lines.
 *
 * @param name The widget name.
 * @returns The lines (no indent).
 */
export function androidWidgetReceiver(name: string): string[] {
  return [
    `<receiver android:name="dev.denext.widgets.${name}Widget" android:exported="false" android:label="${name}">`,
    "    <intent-filter>",
    '        <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />',
    "    </intent-filter>",
    `    <meta-data android:name="android.appwidget.provider" android:resource="@xml/denext_widget_${
      snakeName(name)
    }_info" />`,
    "</receiver>",
  ];
}
