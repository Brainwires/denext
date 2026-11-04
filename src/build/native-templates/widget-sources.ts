// The readable source of the per-name widget and Live Activity templates in
// src/build/widget-native-templates.ts. NOT published: `deno task gen:native-templates`
// (scripts/gen-native-templates.ts) packs every exported record below into the docs-corpus
// pack, which the published module reads. Edit the templates here, then regenerate;
// tests/native-templates-packed.test.ts fails while the packed copy differs.
// Each `{{=name}}` is a hole the published function fills (`fillTemplate`,
// src/build/packed-text.ts): every hole needs a value, and every value a hole.

/**
 * The per-name widget and Live Activity sources, without their header comment: `name` is the
 * widget or Live Activity name, `res` its Android resource name, `rPackage` the app's `R` package;
 * `enums`, `fields`, `chosen` and `defaults` are a configurable widget's parameter code, and
 * `lock` / `island` the Live Activity dispatcher's cases.
 */
export const WIDGET_SOURCE_TEMPLATES: Readonly<Record<string, string>> = {
  "Widget.swift": String.raw`
import SwiftUI
import WidgetKit

/// One timeline entry of the {{=name}} widget.
struct {{=name}}Entry: TimelineEntry {
    let date: Date
    let title: String
    let text: String
}

/// Reads what setWidgetData("{{=name}}", data) stored; reloadWidgets("{{=name}}") (and every
/// setWidgetData) asks WidgetKit for a new timeline.
struct {{=name}}Provider: TimelineProvider {
    func placeholder(in context: Context) -> {{=name}}Entry {
        {{=name}}Entry(date: Date(), title: "{{=name}}", text: "")
    }

    func getSnapshot(in context: Context, completion: @escaping ({{=name}}Entry) -> Void) {
        completion(entry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<{{=name}}Entry>) -> Void) {
        completion(Timeline(entries: [entry()], policy: .never))
    }

    private func entry() -> {{=name}}Entry {
        let data = DenextWidgetStore.object(kind: "{{=name}}") ?? [:]
        return {{=name}}Entry(
            date: Date(),
            title: data["title"] as? String ?? "{{=name}}",
            text: data["body"] as? String ?? "Open the app to load this widget."
        )
    }
}

/// The widget's view: edit it freely.
struct {{=name}}WidgetView: View {
    let entry: {{=name}}Entry

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

/// The {{=name}} widget (kind "{{=name}}").
struct {{=name}}Widget: Widget {
    let kind = "{{=name}}"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: {{=name}}Provider()) { entry in
            {{=name}}WidgetView(entry: entry)
        }
        .configurationDisplayName("{{=name}}")
        .description("{{=name}}")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
`,
  "ConfigurableWidget.swift": String.raw`
import AppIntents
import SwiftUI
import WidgetKit

/// One timeline entry of the {{=name}} widget.
struct {{=name}}Entry: TimelineEntry {
    let date: Date
    let title: String
    let text: String
    /// The values the user chose, by parameter name (the defaults on iOS 14–16).
    let params: [String: String]
}

/// Reads what setWidgetData("{{=name}}", data, { params }) stored for the chosen values, else what
/// setWidgetData("{{=name}}", data) stored; reloadWidgets("{{=name}}") (and every setWidgetData)
/// asks WidgetKit for new timelines.
enum {{=name}}Snapshot {
    /// Each parameter's default: its first value.
    static let defaults: [String: String] = [
{{=defaults}}    ]

    static func placeholder() -> {{=name}}Entry {
        {{=name}}Entry(date: Date(), title: "{{=name}}", text: "", params: defaults)
    }

    static func entry(_ params: [String: String]) -> {{=name}}Entry {
        let data = DenextWidgetStore.object(kind: "{{=name}}", params: params) ?? [:]
        return {{=name}}Entry(
            date: Date(),
            title: data["title"] as? String ?? "{{=name}}",
            text: data["body"] as? String ?? "Open the app to load this widget.",
            params: params
        )
    }
}

/// The widget's view: edit it freely (entry.params holds the chosen values).
struct {{=name}}WidgetView: View {
    let entry: {{=name}}Entry

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
struct {{=name}}StaticProvider: TimelineProvider {
    func placeholder(in context: Context) -> {{=name}}Entry {
        {{=name}}Snapshot.placeholder()
    }

    func getSnapshot(in context: Context, completion: @escaping ({{=name}}Entry) -> Void) {
        completion({{=name}}Snapshot.entry({{=name}}Snapshot.defaults))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<{{=name}}Entry>) -> Void) {
        completion(Timeline(entries: [{{=name}}Snapshot.entry({{=name}}Snapshot.defaults)], policy: .never))
    }
}

/// The {{=name}} widget before iOS 17 (kind "{{=name}}.static"): not configurable. On iOS 17 and
/// later it lists no family, so only {{=name}}ConfigurableWidget is offered.
struct {{=name}}Widget: Widget {
    let kind = "{{=name}}.static"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: {{=name}}StaticProvider()) { entry in
            {{=name}}WidgetView(entry: entry)
        }
        .configurationDisplayName("{{=name}}")
        .description("{{=name}}")
        .supportedFamilies({{=name}}Widget.families)
    }

    static var families: [WidgetFamily] {
        if #available(iOSApplicationExtension 17.0, *) { return [] }
        return [.systemSmall, .systemMedium]
    }
}

{{=enums}}
/// What the user picks when editing the widget.
@available(iOS 17.0, *)
struct {{=name}}ConfigurationIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "{{=name}}"
    static let description: IntentDescription? = IntentDescription("Choose what the {{=name}} widget shows.")

{{=fields}}
    /// The chosen values by parameter name: the params setWidgetData stored the snapshot under.
    var params: [String: String] {
        [
{{=chosen}}        ]
    }
}

/// iOS 17 and later: the snapshot for the values the user chose.
@available(iOS 17.0, *)
struct {{=name}}IntentProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> {{=name}}Entry {
        {{=name}}Snapshot.placeholder()
    }

    func snapshot(for configuration: {{=name}}ConfigurationIntent, in context: Context) async -> {{=name}}Entry {
        {{=name}}Snapshot.entry(configuration.params)
    }

    func timeline(for configuration: {{=name}}ConfigurationIntent, in context: Context) async -> Timeline<{{=name}}Entry> {
        Timeline(entries: [{{=name}}Snapshot.entry(configuration.params)], policy: .never)
    }
}

/// The configurable {{=name}} widget (kind "{{=name}}", iOS 17 and later).
@available(iOS 17.0, *)
struct {{=name}}ConfigurableWidget: Widget {
    let kind = "{{=name}}"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: {{=name}}ConfigurationIntent.self, provider: {{=name}}IntentProvider()) { entry in
            {{=name}}WidgetView(entry: entry)
        }
        .configurationDisplayName("{{=name}}")
        .description("{{=name}}")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
`,
  "LiveActivities.swift": String
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
{{=lock}}            default: DenextLiveActivities.fallback(context)
            }
        } dynamicIsland: { context in
            DenextLiveActivities.island(context)
        }
    }

    static func island(_ context: ActivityViewContext<DenextActivityAttributes>) -> DynamicIsland {
        switch context.attributes.name {
{{=island}}        default:
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
`,
  "LiveActivity.swift": String.raw`
import ActivityKit
import SwiftUI
import WidgetKit

/// The {{=name}} Live Activity's UI: startLiveActivity("{{=name}}", attributes, state) shows it, and
/// context.state holds the latest state object (updateLiveActivity, or an ActivityKit push).
@available(iOS 16.1, *)
enum {{=name}}LiveActivity {
    /// The Lock Screen / banner presentation.
    @ViewBuilder
    static func lockScreen(_ context: ActivityViewContext<DenextActivityAttributes>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(context.state["title"]?.text ?? "{{=name}}").font(.headline)
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
                Text(context.state["title"]?.text ?? "{{=name}}").font(.headline)
            }
            DynamicIslandExpandedRegion(.bottom) {
                Text(context.state["body"]?.text ?? "").font(.subheadline)
            }
        } compactLeading: {
            Text("{{=name}}".prefix(1))
        } compactTrailing: {
            if let progress = context.state["progress"]?.number {
                Text("\(Int(min(max(progress, 0), 1) * 100))%")
            }
        } minimal: {
            Text("{{=name}}".prefix(1))
        }
    }
}
`,
  "Widget.java": String.raw`
package dev.denext.widgets;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import {{=rPackage}}.R;
import org.json.JSONObject;

/**
 * The {{=name}} home-screen widget: shows what {@code setWidgetData("{{=name}}", data)} stored
 * ({@code title} and {@code body}, as a starting point). Its layout is
 * {@code res/layout/denext_widget_{{=res}}.xml}, its size and preview
 * {@code res/xml/denext_widget_{{=res}}_info.xml}. Edit freely.
 */
public class {{=name}}Widget extends AppWidgetProvider {

    /** The widget kind setWidgetData / reloadWidgets name. */
    public static final String KIND = "{{=name}}";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        JSONObject data = DenextWidgetsPlugin.data(context, KIND);
        String title = data == null ? KIND : data.optString("title", KIND);
        String body = data == null ? "Open the app to load this widget." : data.optString("body", "");
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent open = launch == null ? null : PendingIntent.getActivity(
            context, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.denext_widget_{{=res}});
            views.setTextViewText(R.id.denext_widget_title, title);
            views.setTextViewText(R.id.denext_widget_body, body);
            if (open != null) views.setOnClickPendingIntent(R.id.denext_widget_root, open);
            manager.updateAppWidget(id, views);
        }
    }
}
`,
  "widget_layout.xml": String
    .raw`<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
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
`,
};
