// fallow-ignore-file duplicate-export -- the readable source of the same-named published exports
// The readable source of the native templates in src/build/widget-native-templates.ts. NOT
// published: `deno task gen:native-templates` (scripts/gen-native-templates.ts) packs every
// exported record below into src/build/native-templates.packed.ts (Brotli + base64), which
// the published module reads. Edit the templates here, then regenerate;
// tests/native-templates-packed.test.ts fails while the packed copy differs.

import { HEADER } from "../widget-template-header.ts";

/** Swift sources for `ios/App/DenextWidgets/` every widget extension has, keyed by file name. */
export const WIDGETS_IOS_FILES: Readonly<Record<string, string>> = {
  "DenextWidgetStore.swift": HEADER("widget", false) + String.raw`
import Foundation
import SwiftUI

/// What setWidgetData(kind, data) from denext/mobile stored: the JSON the app wrote to the App
/// Group's shared defaults (key denext.widget.<kind>). The App Group is the extension's
/// Info.plist DenextAppGroup. A configurable widget passes the values the user chose as params:
/// setWidgetData(kind, data, { params }) stored the snapshot for exactly those values, and the
/// one stored without params is the fallback.
enum DenextWidgetStore {
    /// The App Group identifier from Info.plist, if set.
    static var appGroup: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "DenextAppGroup") as? String,
              !value.isEmpty else { return nil }
        return value
    }

    /// The defaults key: denext.widget.<kind>, or denext.widget.<kind>?<name>=<value>&… with
    /// the parameter names sorted.
    static func key(kind: String, params: [String: String] = [:]) -> String {
        let query = params.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
            .joined(separator: "&")
        return query.isEmpty ? "denext.widget.\(kind)" : "denext.widget.\(kind)?\(query)"
    }

    /// The raw JSON text for kind (and params, falling back to the snapshot stored without
    /// them), if the app stored any.
    static func json(kind: String, params: [String: String] = [:]) -> String? {
        guard let group = appGroup, let defaults = UserDefaults(suiteName: group) else { return nil }
        if !params.isEmpty, let text = defaults.string(forKey: key(kind: kind, params: params)) {
            return text
        }
        return defaults.string(forKey: key(kind: kind))
    }

    /// The stored JSON for kind (and params) as an object, if it is one.
    static func object(kind: String, params: [String: String] = [:]) -> [String: Any]? {
        guard let data = json(kind: kind, params: params)?.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// The stored JSON for kind (and params) decoded as T.
    static func decode<T: Decodable>(
        _ type: T.Type,
        kind: String,
        params: [String: String] = [:]
    ) -> T? {
        guard let data = json(kind: kind, params: params)?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

extension View {
    /// The widget background: the system container background on iOS 17 and later, padding over
    /// the system background before.
    @ViewBuilder
    func denextWidgetBackground() -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            containerBackground(for: .widget) { Color(UIColor.systemBackground) }
        } else {
            padding().background(Color(UIColor.systemBackground))
        }
    }
}
`,
};

/** The ActivityKit attributes both the App and the widget extension compile. */
export const LIVE_ACTIVITY_SHARED_FILES: Readonly<Record<string, string>> = {
  "DenextActivityAttributes.swift": HEADER("live-activity", false) +
    String
      .raw`// Compiled into the widget extension AND the App target (both must agree on the type).

import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// A JSON value: what startLiveActivity / updateLiveActivity pass from denext/mobile.
public enum DenextJSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([DenextJSONValue])
    case object([String: DenextJSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([DenextJSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: DenextJSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    /// The value for display: a string as is, a number without a trailing .0, a bool as
    /// true/false; nil for null, arrays and objects.
    public var text: String? {
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value.rounded() == value && abs(value) < 1e15 ? String(Int64(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        default: return nil
        }
    }

    /// The number, if it is one.
    public var number: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
}

/// The attributes of every denext Live Activity: its name (which UI renders it, see
/// DenextLiveActivities.swift) and the static values startLiveActivity passed. ContentState is
/// the dynamic state object, encoded as that plain JSON object, so an ActivityKit push update's
/// "content-state" is the same object updateLiveActivity takes.
@available(iOS 16.1, *)
public struct DenextActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var values: [String: DenextJSONValue]

        public init(values: [String: DenextJSONValue]) {
            self.values = values
        }

        public init(from decoder: Decoder) throws {
            values = try decoder.singleValueContainer().decode([String: DenextJSONValue].self)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            try container.encode(values)
        }

        public subscript(key: String) -> DenextJSONValue? {
            return values[key]
        }
    }

    public var name: String
    public var values: [String: DenextJSONValue]

    public init(name: String, values: [String: DenextJSONValue]) {
        self.name = name
        self.values = values
    }

    public subscript(key: String) -> DenextJSONValue? {
        return values[key]
    }
}
`,
};

/** App-side plugins for `ios/App/App/`, keyed by file name. */
export const WIDGETS_PLUGIN_IOS_FILES: Readonly<Record<string, string>> = {
  "DenextWidgetsPlugin.swift": HEADER("widget", false) + String.raw`
@preconcurrency import Capacitor
import Foundation
import WidgetKit

/// The native side of setWidgetData() / reloadWidgets() from denext/mobile, reached from the
/// web app as window.Capacitor.Plugins.DenextWidgets. DenextBridgeViewController registers it.
///
/// - setData({ kind, json, params? }): stores json (the text of a JSON value) in the App Group's
///   shared defaults under denext.widget.<kind> (with params, a configurable widget's chosen
///   values: denext.widget.<kind>?<name>=<value>&… sorted by name; the widget extension reads it
///   through DenextWidgetStore) and reloads that kind's timelines. Rejects with code invalid for
///   a bad kind or params, unavailable without the App Group (Info.plist DenextAppGroup + the
///   application-groups entitlement).
/// - reload({ kind? }): reloads one kind's timelines, or every widget's. A kind's timelines
///   include "<kind>.static", the pre-iOS 17 face of a configurable widget.
@objc(DenextWidgetsPlugin)
public class DenextWidgetsPlugin: CAPPlugin, CAPBridgedPlugin, @unchecked Sendable {
    public let identifier = "DenextWidgetsPlugin"
    public let jsName = "DenextWidgets"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise)
    ]

    @objc func setData(_ call: CAPPluginCall) {
        guard let kind = call.getString("kind"), Self.isKind(kind) else {
            call.reject("kind must be a widget name such as Status", "invalid")
            return
        }
        guard let json = call.getString("json") else {
            call.reject("json must be the text of a JSON value", "invalid")
            return
        }
        guard let group = Bundle.main.object(forInfoDictionaryKey: "DenextAppGroup") as? String,
              !group.isEmpty, let defaults = UserDefaults(suiteName: group) else {
            call.reject("the App Group is unavailable (Info.plist DenextAppGroup and the application-groups entitlement)", "unavailable")
            return
        }
        var params: [String: String] = [:]
        for (name, value) in call.getObject("params") ?? [:] {
            guard let text = value as? String, Self.isParam(name), Self.isParam(text) else {
                call.reject("params must map parameter names to enum values", "invalid")
                return
            }
            params[name] = text
        }
        let query = params.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
            .joined(separator: "&")
        defaults.set(json, forKey: query.isEmpty ? "denext.widget.\(kind)" : "denext.widget.\(kind)?\(query)")
        Self.reloadKind(kind)
        call.resolve()
    }

    @objc func reload(_ call: CAPPluginCall) {
        if let kind = call.getString("kind") {
            guard Self.isKind(kind) else {
                call.reject("kind must be a widget name such as Status", "invalid")
                return
            }
            Self.reloadKind(kind)
        } else {
            WidgetCenter.shared.reloadAllTimelines()
        }
        call.resolve()
    }

    /// Reload kind's timelines and those of its pre-iOS 17 static face.
    private static func reloadKind(_ kind: String) {
        WidgetCenter.shared.reloadTimelines(ofKind: kind)
        WidgetCenter.shared.reloadTimelines(ofKind: "\(kind).static")
    }

    private static func isKind(_ kind: String) -> Bool {
        return kind.range(of: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$", options: .regularExpression) != nil
    }

    private static func isParam(_ text: String) -> Bool {
        return text.range(of: "^[A-Za-z][A-Za-z0-9_]{0,63}$", options: .regularExpression) != nil
    }
}
`,
};

/** The Live Activity plugin for `ios/App/App/`. */
export const LIVE_ACTIVITY_PLUGIN_IOS_FILES: Readonly<Record<string, string>> = {
  "DenextLiveActivityPlugin.swift": HEADER("live-activity", false) + String.raw`
@preconcurrency import Capacitor
import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// The native side of the Live Activity functions of denext/mobile, reached from the web app as
/// window.Capacitor.Plugins.DenextLiveActivity. DenextBridgeViewController registers it.
/// ActivityKit needs iOS 16.1: on an older iOS every method rejects with code unsupported (the
/// app keeps its own deployment target).
///
/// - start({ name, attributes, state, push }) → { id }: attributes and state are the text of
///   JSON objects. push asks for an ActivityKit push token (the app needs the push entitlement).
///   Rejects with disabled (Live Activities are off for the app), invalid or failed.
/// - update({ id, state }), end({ id, state?, dismissal?, dismissalAt? }): not_found for an
///   unknown id. dismissalAt (ms since the epoch) removes the ended activity at that time.
/// - pushToken({ id, timeoutMs }) → { token }: the hex push token, waiting for it up to
///   timeoutMs; rejects with timeout.
/// - pushToStartToken({ timeoutMs }) → { supported, token? }: the hex push-to-start token
///   (iOS 17.2+; supported is false before), waiting for it up to timeoutMs; rejects with
///   timeout. A server starts an activity remotely with it (APNs push type liveactivity).
/// - list() → { activities: [{ id, name }] }: the running activities.
///
/// Events: "pushToken" { id, token } whenever ActivityKit issues a running activity a push
/// token, and "pushToStartToken" { token } whenever it issues the app a push-to-start token
/// (iOS 17.2+). Both are kept until the first listener takes them.
@objc(DenextLiveActivityPlugin)
public class DenextLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin, @unchecked Sendable {
    public let identifier = "DenextLiveActivityPlugin"
    public let jsName = "DenextLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pushToStartToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise)
    ]

    /// The ids of the activities whose push tokens are observed.
    private let observedLock = NSLock()
    private var observed = Set<String>()

    override public func load() {
        if #available(iOS 16.1, *) {
            for activity in Activity<DenextActivityAttributes>.activities { observe(activity) }
            Task { [weak self] in
                for await activity in Activity<DenextActivityAttributes>.activityUpdates {
                    self?.observe(activity)
                }
            }
        }
        if #available(iOS 17.2, *) {
            Task { [weak self] in
                for await token in Activity<DenextActivityAttributes>.pushToStartTokenUpdates {
                    self?.notifyListeners("pushToStartToken", data: ["token": Self.hex(token)], retainUntilConsumed: true)
                }
            }
        }
    }

    /// Post a "pushToken" event for each push token ActivityKit issues activity (once per id).
    @available(iOS 16.1, *)
    private func observe(_ activity: Activity<DenextActivityAttributes>) {
        let id = activity.id
        observedLock.lock()
        let fresh = observed.insert(id).inserted
        observedLock.unlock()
        guard fresh else { return }
        Task { [weak self] in
            for await token in activity.pushTokenUpdates {
                self?.notifyListeners("pushToken", data: ["id": id, "token": Self.hex(token)], retainUntilConsumed: true)
            }
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { return Self.unsupported(call) }
        guard let name = call.getString("name"), !name.isEmpty,
              let attributes = Self.object(call.getString("attributes")),
              let state = Self.object(call.getString("state")) else {
            call.reject("name, attributes and state are required (attributes and state as JSON objects)", "invalid")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities are turned off for this app", "disabled")
            return
        }
        let push = call.getBool("push") ?? false
        let activityAttributes = DenextActivityAttributes(name: name, values: attributes)
        let contentState = DenextActivityAttributes.ContentState(values: state)
        do {
            let activity: Activity<DenextActivityAttributes>
            if #available(iOS 16.2, *) {
                activity = try Activity.request(
                    attributes: activityAttributes,
                    content: ActivityContent(state: contentState, staleDate: nil),
                    pushType: push ? .token : nil
                )
            } else {
                activity = try Activity.request(
                    attributes: activityAttributes,
                    contentState: contentState,
                    pushType: push ? .token : nil
                )
            }
            if push { observe(activity) }
            call.resolve(["id": activity.id])
        } catch {
            call.reject(error.localizedDescription, "failed")
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { return Self.unsupported(call) }
        guard let activity = Self.activity(call), let state = Self.object(call.getString("state")) else {
            return Self.missing(call)
        }
        let contentState = DenextActivityAttributes.ContentState(values: state)
        Task {
            if #available(iOS 16.2, *) {
                await activity.update(ActivityContent(state: contentState, staleDate: nil))
            } else {
                await activity.update(using: contentState)
            }
            call.resolve()
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { return Self.unsupported(call) }
        guard let activity = Self.activity(call) else { return Self.missing(call) }
        let state = Self.object(call.getString("state")).map { DenextActivityAttributes.ContentState(values: $0) }
        let policy: ActivityUIDismissalPolicy
        if let at = call.getDouble("dismissalAt") {
            policy = .after(Date(timeIntervalSince1970: at / 1000))
        } else {
            policy = call.getString("dismissal") == "immediate" ? .immediate : .default
        }
        Task {
            if #available(iOS 16.2, *) {
                let content = state.map { ActivityContent(state: $0, staleDate: nil) }
                await activity.end(content, dismissalPolicy: policy)
            } else {
                await activity.end(using: state, dismissalPolicy: policy)
            }
            call.resolve()
        }
    }

    @objc func pushToken(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else { return Self.unsupported(call) }
        guard let activity = Self.activity(call) else { return Self.missing(call) }
        if let token = activity.pushToken {
            call.resolve(["token": Self.hex(token)])
            return
        }
        Self.wait(
            call,
            for: activity.pushTokenUpdates,
            result: [:],
            ended: "the Live Activity ended without a push token",
            timedOut: "no push token yet (was it started with push: true?)"
        )
    }

    @objc func pushToStartToken(_ call: CAPPluginCall) {
        guard #available(iOS 17.2, *) else {
            call.resolve(["supported": false])
            return
        }
        if let token = Activity<DenextActivityAttributes>.pushToStartToken {
            call.resolve(["supported": true, "token": Self.hex(token)])
            return
        }
        Self.wait(
            call,
            for: Activity<DenextActivityAttributes>.pushToStartTokenUpdates,
            result: ["supported": true],
            ended: "ActivityKit issued no push-to-start token",
            timedOut: "no push-to-start token yet (does the app have the push entitlement?)"
        )
    }

    @objc func list(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["activities": [[String: String]]()])
            return
        }
        let running = Activity<DenextActivityAttributes>.activities.filter {
            $0.activityState != .ended && $0.activityState != .dismissed
        }
        call.resolve(["activities": running.map { ["id": $0.id, "name": $0.attributes.name] }])
    }

    /// Resolve call with result plus the first token updates yields (as hex), or reject it with
    /// code timeout once timeoutMs (default 10 000) passes or the sequence ends.
    @available(iOS 16.1, *)
    private static func wait(
        _ call: CAPPluginCall,
        for updates: Activity<DenextActivityAttributes>.PushTokenUpdates,
        result: [String: Any],
        ended: String,
        timedOut: String
    ) {
        let timeout = max(call.getDouble("timeoutMs") ?? 10_000, 0) / 1000
        let settled = Settled()
        let waiter = Task {
            for await token in updates {
                if settled.claim() { call.resolve(result.merging(["token": hex(token)]) { $1 }) }
                return
            }
            if settled.claim() { call.reject(ended, "timeout") }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            if settled.claim() {
                waiter.cancel()
                call.reject(timedOut, "timeout")
            }
        }
    }

    /// A one-shot flag: the first claim wins.
    private final class Settled: @unchecked Sendable {
        private let lock = NSLock()
        private var done = false

        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if done { return false }
            done = true
            return true
        }
    }

    @available(iOS 16.1, *)
    private static func activity(_ call: CAPPluginCall) -> Activity<DenextActivityAttributes>? {
        guard let id = call.getString("id") else { return nil }
        return Activity<DenextActivityAttributes>.activities.first { $0.id == id }
    }

    private static func object(_ json: String?) -> [String: DenextJSONValue]? {
        guard let data = json?.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: DenextJSONValue].self, from: data)
    }

    private static func hex(_ data: Data) -> String {
        return data.map { String(format: "%02x", $0) }.joined()
    }

    private static func unsupported(_ call: CAPPluginCall) {
        call.reject("Live Activities need iOS 16.1 or later", "unsupported")
    }

    private static func missing(_ call: CAPPluginCall) {
        call.reject("no Live Activity with that id (or a missing state)", "not_found")
    }
}
`,
};

/** The Android widgets plugin for `dev/denext/widgets/`. */
export const WIDGETS_ANDROID_FILES: Readonly<Record<string, string>> = {
  "DenextWidgetsPlugin.java": HEADER("widget", false) + String.raw`
package dev.denext.widgets;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * The native side of {@code setWidgetData()} / {@code reloadWidgets()} from {@code denext/mobile},
 * reached from the web app as {@code window.Capacitor.Plugins.DenextWidgets}. {@code MainActivity}
 * registers it.
 *
 * <ul>
 *   <li>{@code setData({ kind, json, params? })}: stores {@code json} in the
 *       {@code denext_widgets} shared preferences under {@code kind} and updates that kind's
 *       widgets. With {@code params} (the values of an iOS configurable widget) the key is
 *       {@code <kind>?<name>=<value>&…}, names sorted: Android widgets are not configurable, so
 *       they read the snapshot stored without params.
 *   <li>{@code reload({ kind? })}: updates one kind's widgets, or all of this app's.
 * </ul>
 *
 * <p>A kind's widgets are the app's AppWidgetProviders named {@code <kind>Widget} (what
 * {@code denext mobile add widget --name <kind>} writes); they read the data with
 * {@link #data(Context, String)}.
 */
@CapacitorPlugin(name = "DenextWidgets")
public class DenextWidgetsPlugin extends Plugin {

    /** The shared preferences the data is stored in. */
    public static final String PREFS = "denext_widgets";
    private static final Pattern KIND = Pattern.compile("^[A-Za-z][A-Za-z0-9_.-]{0,63}$");
    private static final Pattern PARAM = Pattern.compile("^[A-Za-z][A-Za-z0-9_]{0,63}$");

    @PluginMethod
    public void setData(PluginCall call) {
        String kind = call.getString("kind");
        String json = call.getString("json");
        if (kind == null || !KIND.matcher(kind).matches()) {
            call.reject("kind must be a widget name such as Status", "invalid");
            return;
        }
        if (json == null) {
            call.reject("json must be the text of a JSON value", "invalid");
            return;
        }
        String key = key(kind, call.getObject("params"));
        if (key == null) {
            call.reject("params must map parameter names to enum values", "invalid");
            return;
        }
        Context context = getContext();
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(key, json).apply();
        reload(context, kind);
        call.resolve();
    }

    @PluginMethod
    public void reload(PluginCall call) {
        String kind = call.getString("kind");
        if (kind != null && !KIND.matcher(kind).matches()) {
            call.reject("kind must be a widget name such as Status", "invalid");
            return;
        }
        reload(getContext(), kind);
        call.resolve();
    }

    /** The preferences key for {@code kind} and {@code params}, or null for bad params. */
    @Nullable
    private static String key(String kind, @Nullable JSObject params) {
        if (params == null || params.length() == 0) return kind;
        TreeMap<String, String> sorted = new TreeMap<>();
        Iterator<String> names = params.keys();
        while (names.hasNext()) {
            String name = names.next();
            Object value = params.opt(name);
            if (!(value instanceof String) || !PARAM.matcher(name).matches()
                    || !PARAM.matcher((String) value).matches()) {
                return null;
            }
            sorted.put(name, (String) value);
        }
        StringBuilder query = new StringBuilder();
        for (Map.Entry<String, String> entry : sorted.entrySet()) {
            if (query.length() > 0) query.append('&');
            query.append(entry.getKey()).append('=').append(entry.getValue());
        }
        return kind + "?" + query;
    }

    /** Ask every placed widget of {@code kind} (null: of this app) to update. */
    public static void reload(Context context, @Nullable String kind) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        if (manager == null) return;
        String suffix = kind == null ? null : "." + kind + "Widget";
        for (AppWidgetProviderInfo info : manager.getInstalledProviders()) {
            ComponentName provider = info.provider;
            if (!provider.getPackageName().equals(context.getPackageName())) continue;
            if (suffix != null && !provider.getClassName().endsWith(suffix)) continue;
            int[] ids = manager.getAppWidgetIds(provider);
            if (ids == null || ids.length == 0) continue;
            Intent intent = new Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
            intent.setComponent(provider);
            intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
            context.sendBroadcast(intent);
        }
    }

    /** The JSON object {@code setWidgetData(kind, …)} stored, or null. */
    @Nullable
    public static JSONObject data(Context context, String kind) {
        String json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(kind, null);
        if (json == null) return null;
        try {
            return new JSONObject(json);
        } catch (Exception e) {
            return null;
        }
    }
}
`,
};
