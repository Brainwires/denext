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
// The templates are `String.raw` literals: only `${…}` interpolates.
//
// The template texts ship packed: native-templates/widget.ts (the readable source, not published)
// is packed with the others into native-templates.packed.ts by `deno task gen:native-templates`.

import { NATIVE_TEMPLATES } from "./native-templates.packed.ts";
import { HEADER } from "./widget-template-header.ts";

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
  return HEADER("widget", true) + String.raw`
import SwiftUI
import WidgetKit

/// One timeline entry of the ${name} widget.
struct ${name}Entry: TimelineEntry {
    let date: Date
    let title: String
    let text: String
}

/// Reads what setWidgetData("${name}", data) stored; reloadWidgets("${name}") (and every
/// setWidgetData) asks WidgetKit for a new timeline.
struct ${name}Provider: TimelineProvider {
    func placeholder(in context: Context) -> ${name}Entry {
        ${name}Entry(date: Date(), title: "${name}", text: "")
    }

    func getSnapshot(in context: Context, completion: @escaping (${name}Entry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<${name}Entry>) -> Void) {
        completion(Timeline(entries: [entry()], policy: .never))
    }

    private func entry() -> ${name}Entry {
        let data = DenextWidgetStore.object(kind: "${name}") ?? [:]
        return ${name}Entry(
            date: Date(),
            title: data["title"] as? String ?? "${name}",
            text: data["body"] as? String ?? "Open the app to load this widget."
        )
    }
}

/// The widget's view: edit it freely.
struct ${name}WidgetView: View {
    let entry: ${name}Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.title).font(.headline).lineLimit(2)
            Text(entry.text).font(.subheadline).foregroundColor(.secondary).lineLimit(4)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .denextWidgetBackground()
    }
}

/// The ${name} widget (kind "${name}").
struct ${name}Widget: Widget {
    let kind = "${name}"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ${name}Provider()) { entry in
            ${name}WidgetView(entry: entry)
        }
        .configurationDisplayName("${name}")
        .description("${name}")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
`;
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
` + String.raw`
import AppIntents
import SwiftUI
import WidgetKit

/// One timeline entry of the ${name} widget.
struct ${name}Entry: TimelineEntry {
    let date: Date
    let title: String
    let text: String
    /// The values the user chose, by parameter name (the defaults on iOS 14–16).
    let params: [String: String]
}

/// Reads what setWidgetData("${name}", data, { params }) stored for the chosen values, else what
/// setWidgetData("${name}", data) stored; reloadWidgets("${name}") (and every setWidgetData)
/// asks WidgetKit for new timelines.
enum ${name}Snapshot {
    /// Each parameter's default: its first value.
    static let defaults: [String: String] = [
${defaults}    ]

    static func placeholder() -> ${name}Entry {
        ${name}Entry(date: Date(), title: "${name}", text: "", params: defaults)
    }

    static func entry(_ params: [String: String]) -> ${name}Entry {
        let data = DenextWidgetStore.object(kind: "${name}", params: params) ?? [:]
        return ${name}Entry(
            date: Date(),
            title: data["title"] as? String ?? "${name}",
            text: data["body"] as? String ?? "Open the app to load this widget.",
            params: params
        )
    }
}

/// The widget's view: edit it freely (entry.params holds the chosen values).
struct ${name}WidgetView: View {
    let entry: ${name}Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.title).font(.headline).lineLimit(2)
            Text(entry.text).font(.subheadline).foregroundColor(.secondary).lineLimit(4)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .denextWidgetBackground()
    }
}

/// iOS 14–16: the defaults' snapshot.
struct ${name}StaticProvider: TimelineProvider {
    func placeholder(in context: Context) -> ${name}Entry {
        ${name}Snapshot.placeholder()
    }

    func getSnapshot(in context: Context, completion: @escaping (${name}Entry) -> Void) {
        completion(${name}Snapshot.entry(${name}Snapshot.defaults))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<${name}Entry>) -> Void) {
        completion(Timeline(entries: [${name}Snapshot.entry(${name}Snapshot.defaults)], policy: .never))
    }
}

/// The ${name} widget before iOS 17 (kind "${name}.static"): not configurable. On iOS 17 and
/// later it lists no family, so only ${name}ConfigurableWidget is offered.
struct ${name}Widget: Widget {
    let kind = "${name}.static"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: ${name}StaticProvider()) { entry in
            ${name}WidgetView(entry: entry)
        }
        .configurationDisplayName("${name}")
        .description("${name}")
        .supportedFamilies(${name}Widget.families)
    }

    static var families: [WidgetFamily] {
        if #available(iOSApplicationExtension 17.0, *) { return [] }
        return [.systemSmall, .systemMedium]
    }
}

${enums}
/// What the user picks when editing the widget.
@available(iOS 17.0, *)
struct ${name}ConfigurationIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "${name}"
    static let description: IntentDescription? = IntentDescription("Choose what the ${name} widget shows.")

${fields}
    /// The chosen values by parameter name: the params setWidgetData stored the snapshot under.
    var params: [String: String] {
        [
${chosen}        ]
    }
}

/// iOS 17 and later: the snapshot for the values the user chose.
@available(iOS 17.0, *)
struct ${name}IntentProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> ${name}Entry {
        ${name}Snapshot.placeholder()
    }

    func snapshot(for configuration: ${name}ConfigurationIntent, in context: Context) async -> ${name}Entry {
        ${name}Snapshot.entry(configuration.params)
    }

    func timeline(for configuration: ${name}ConfigurationIntent, in context: Context) async -> Timeline<${name}Entry> {
        Timeline(entries: [${name}Snapshot.entry(configuration.params)], policy: .never)
    }
}

/// The configurable ${name} widget (kind "${name}", iOS 17 and later).
@available(iOS 17.0, *)
struct ${name}ConfigurableWidget: Widget {
    let kind = "${name}"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: ${name}ConfigurationIntent.self, provider: ${name}IntentProvider()) { entry in
            ${name}WidgetView(entry: entry)
        }
        .configurationDisplayName("${name}")
        .description("${name}")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
`;
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
    String
      .raw`// Rewritten while unedited whenever a Live Activity is added; if you edit it, add new names to
// both switches yourself.

import ActivityKit
import SwiftUI
import WidgetKit

/// Every denext Live Activity, dispatched on DenextActivityAttributes.name.
@available(iOS 16.1, *)
struct DenextLiveActivities: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DenextActivityAttributes.self) { context in
            switch context.attributes.name {
${lock.join("")}            default: DenextLiveActivities.fallback(context)
            }
        } dynamicIsland: { context in
            DenextLiveActivities.island(context)
        }
    }

    static func island(_ context: ActivityViewContext<DenextActivityAttributes>) -> DynamicIsland {
        switch context.attributes.name {
${island.join("")}        default:
            return DynamicIsland {
                DynamicIslandExpandedRegion(.center) { fallback(context) }
            } compactLeading: {
                Text(context.attributes.name.prefix(1))
            } compactTrailing: {
                EmptyView()
            } minimal: {
                Text(context.attributes.name.prefix(1))
            }
        }
    }

    /// An activity whose name has no UI here: its name and state title.
    @ViewBuilder
    static func fallback(_ context: ActivityViewContext<DenextActivityAttributes>) -> some View {
        VStack(alignment: .leading) {
            Text(context.state["title"]?.text ?? context.attributes.name).font(.headline)
        }
        .padding()
    }
}
`;
}

/**
 * `<Name>LiveActivity.swift`: the Lock Screen and Dynamic Island UI of Live Activity `name`
 * (state `title`, `body` and `progress` from 0 to 1, as a starting point).
 *
 * @param name The Live Activity name.
 * @returns The template (without its marker).
 */
export function liveActivitySource(name: string): string {
  return HEADER("live-activity", true) + String.raw`
import ActivityKit
import SwiftUI
import WidgetKit

/// The ${name} Live Activity's UI: startLiveActivity("${name}", attributes, state) shows it, and
/// context.state holds the latest state object (updateLiveActivity, or an ActivityKit push).
@available(iOS 16.1, *)
enum ${name}LiveActivity {
    /// The Lock Screen / banner presentation.
    @ViewBuilder
    static func lockScreen(_ context: ActivityViewContext<DenextActivityAttributes>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(context.state["title"]?.text ?? "${name}").font(.headline)
            if let text = context.state["body"]?.text {
                Text(text).font(.subheadline).foregroundColor(.secondary)
            }
            if let progress = context.state["progress"]?.number {
                ProgressView(value: min(max(progress, 0), 1))
            }
        }
        .padding()
    }

    /// The Dynamic Island presentations.
    static func dynamicIsland(_ context: ActivityViewContext<DenextActivityAttributes>) -> DynamicIsland {
        DynamicIsland {
            DynamicIslandExpandedRegion(.leading) {
                Text(context.state["title"]?.text ?? "${name}").font(.headline)
            }
            DynamicIslandExpandedRegion(.bottom) {
                Text(context.state["body"]?.text ?? "").font(.subheadline)
            }
        } compactLeading: {
            Text("${name}".prefix(1))
        } compactTrailing: {
            if let progress = context.state["progress"]?.number {
                Text("\(Int(min(max(progress, 0), 1) * 100))%")
            }
        } minimal: {
            Text("${name}".prefix(1))
        }
    }
}
`;
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
  return HEADER("widget", true) + String.raw`
package dev.denext.widgets;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import ${rPackage}.R;
import org.json.JSONObject;

/**
 * The ${name} home-screen widget: shows what {@code setWidgetData("${name}", data)} stored
 * ({@code title} and {@code body}, as a starting point). Its layout is
 * {@code res/layout/denext_widget_${res}.xml}, its size and preview
 * {@code res/xml/denext_widget_${res}_info.xml}. Edit freely.
 */
public class ${name}Widget extends AppWidgetProvider {

    /** The widget kind setWidgetData / reloadWidgets name. */
    public static final String KIND = "${name}";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        JSONObject data = DenextWidgetsPlugin.data(context, KIND);
        String title = data == null ? KIND : data.optString("title", KIND);
        String body = data == null ? "Open the app to load this widget." : data.optString("body", "");
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent open = launch == null ? null : PendingIntent.getActivity(
            context, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.denext_widget_${res});
            views.setTextViewText(R.id.denext_widget_title, title);
            views.setTextViewText(R.id.denext_widget_body, body);
            if (open != null) views.setOnClickPendingIntent(R.id.denext_widget_root, open);
            manager.updateAppWidget(id, views);
        }
    }
}
`;
}

/**
 * `res/layout/denext_widget_<name>.xml`: the widget's RemoteViews layout.
 *
 * @returns The template (without its marker; an XML file).
 */
export function androidWidgetLayout(): string {
  return `<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:id="@+id/denext_widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:background="#FFFFFFFF"
    android:orientation="vertical"
    android:padding="12dp">

    <TextView
        android:id="@+id/denext_widget_title"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:maxLines="2"
        android:textColor="#FF111111"
        android:textSize="16sp"
        android:textStyle="bold" />

    <TextView
        android:id="@+id/denext_widget_body"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:layout_marginTop="4dp"
        android:maxLines="4"
        android:textColor="#FF555555"
        android:textSize="14sp" />
</LinearLayout>
`;
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
