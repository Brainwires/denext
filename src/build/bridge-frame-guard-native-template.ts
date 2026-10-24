// The main-frame guard every generated `DenextBridgeViewController.swift` carries (the OTA one,
// the auth-session registering-only one and the app-extension registering-only one), embedded
// as text so it ships inside the JSR package.
//
// Capacitor iOS registers its `bridge` script-message handler (`WebViewDelegationHandler`) on
// the WebView's user content controller, and WebKit delivers a `webkit.messageHandlers.bridge`
// message from EVERY frame of the page. Capacitor's `userContentController(_:didReceive:)` does
// not look at `message.frameInfo.isMainFrame`, so an iframe (a framed site, an ad, a third-party
// widget, the react-native-webview shim's frame) could post a plugin call and reach every
// installed plugin. Capacitor injects its JS bridge into the main frame only, so a message from
// any other frame is never the app's own. The guard takes Capacitor's place under the same
// handler name from `capacitorDidLoad()` (after the bridge exists, before `viewDidLoad()` loads
// the first page) and forwards only main-frame messages to it, unchanged.
//
// The guard also checks the main frame's origin (AU6-L8): only the app's own origin (Capacitor's
// local URL, plus `server.url` in a debug build for live reload) and the Capacitor config's
// `plugins.DenextBridge.allowedOrigins` may call plugins; `plugins.DenextBridge.frameGuard: false`
// turns the origin check off (a hosted `server.url` app, an `allowNavigation` site that calls
// plugins). It is read from the config `cap sync` ships in the app, so the page cannot change it.
//
// Android: Capacitor 8's `MessageHandler` listens through `WebViewCompat.addWebMessageListener`
// and drops a message whose `isMainFrame` is false, but injects its bridge into every origin of
// `allowNavigation` and `server.url`; the composed MainActivity's `BridgeOriginGuard`
// (mobile-native-install.ts) narrows it to the same origins. Only Capacitor's fallback
// (`android.useLegacyBridge`, or a WebView without WEB_MESSAGE_LISTENER) uses
// `addJavascriptInterface`, which every frame can reach; `denext mobile doctor --release` flags
// `useLegacyBridge`.
//
// Edit this as source: it is compiled only in an app (build-checked with xcodebuild against
// Capacitor 8). It is a `String.raw` literal, so the Swift `\(x)` is written as is (and it holds
// no backtick).

/** The Swift import the guard needs, added to the bridge view controller's imports. */
export const FRAME_GUARD_IMPORT = "import WebKit\n";

/** The line that installs the guard, first thing after `super.capacitorDidLoad()`. */
export const FRAME_GUARD_INSTALL =
  "        // denext: native plugin calls are accepted from the app's main frame only.\n" +
  "        DenextMainFrameBridgeGuard.install(on: bridge)\n";

/** The guard class, appended to the bridge view controller's file. */
export const FRAME_GUARD_SWIFT = String.raw`
/// Drops native bridge calls that do not come from the app's own main frame.
///
/// WebKit delivers the bridge script message from every frame of the page, and Capacitor's
/// handler does not check which frame sent it, so an iframe (an embedded site, an ad, a widget)
/// could call any installed plugin. Capacitor injects its JS bridge into the main frame only,
/// so a message from another frame is never the app's own. A main frame on another origin (a
/// server.allowNavigation site, a hosted server.url) is refused too, unless the Capacitor
/// config lists it in plugins.DenextBridge.allowedOrigins or turns the origin check off with
/// plugins.DenextBridge.frameGuard: false. This handler takes Capacitor's place under the same
/// name and forwards the accepted messages to it unchanged.
@MainActor
final class DenextMainFrameBridgeGuard: NSObject, WKScriptMessageHandler {
    /// The name Capacitor registers its handler under (WebViewDelegationHandler.handlerName).
    private static let handlerName = "bridge"
    /// The Capacitor config section the guard reads (plugins.DenextBridge).
    private static let configId = "DenextBridge"
    /// Capacitor's own handler, which the bridge owns.
    private weak var target: WKScriptMessageHandler?
    /// The origins whose main frame may call plugins; nil when the origin check is off.
    private let allowedOrigins: Set<String>?
    /// The frame origins already logged, so a looping frame cannot flood the log.
    private var logged = Set<String>()

    private init(target: WKScriptMessageHandler, allowedOrigins: Set<String>?) {
        self.target = target
        self.allowedOrigins = allowedOrigins
    }

    /// Puts the guard in front of Capacitor's bridge handler. Call it from capacitorDidLoad(),
    /// which runs before the first page loads.
    static func install(on bridge: CAPBridgeProtocol?) {
        guard let bridge = bridge as? CapacitorBridge else {
            NSLog("[denext] could not guard the native bridge: the bridge is not a CapacitorBridge")
            return
        }
        let handler = bridge.webViewDelegationHandler
        let controller = handler.contentController
        controller.removeScriptMessageHandler(forName: handlerName)
        let guardHandler = DenextMainFrameBridgeGuard(
            target: handler,
            allowedOrigins: allowedOrigins(bridge.config)
        )
        controller.add(guardHandler, name: handlerName)
    }

    /// The origins plugin calls are accepted from: the app's own (Capacitor's local URL; in a
    /// debug build also server.url, for live reload), plus plugins.DenextBridge.allowedOrigins.
    /// Nil with plugins.DenextBridge.frameGuard: false (only the main-frame check is kept).
    static func allowedOrigins(_ config: InstanceConfiguration) -> Set<String>? {
        let pluginConfig = config.getPluginConfig(configId)
        guard pluginConfig.getBoolean("frameGuard", true) else { return nil }
        var origins = Set<String>()
        if let local = origin(of: config.localURL) { origins.insert(local) }
        #if DEBUG
        if let server = origin(of: config.serverURL) { origins.insert(server) }
        #endif
        for case let entry as String in pluginConfig.getArray("allowedOrigins", []) ?? [] {
            if let url = URL(string: entry), let allowed = origin(of: url) { origins.insert(allowed) }
        }
        return origins
    }

    /// url's origin as scheme://host[:port] (lower-cased, no default port), or nil.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        return format(scheme: scheme, host: host, port: url.port ?? 0)
    }

    /// An origin as scheme://host[:port]; port 0 (WebKit's "default") and 80 / 443 for
    /// http / https are left out.
    static func format(scheme: String, host: String, port: Int) -> String {
        let isDefault = port == 0 || (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        return isDefault ? "\(scheme)://\(host)" : "\(scheme)://\(host):\(port)"
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        let origin = message.frameInfo.securityOrigin
        let from = Self.format(scheme: origin.protocol.lowercased(), host: origin.host.lowercased(), port: origin.port)
        guard message.frameInfo.isMainFrame else {
            refuse("[denext] refused a native plugin call from a non-main frame (%@)", from)
            return
        }
        if let allowed = allowedOrigins, !allowed.contains(from) {
            refuse(
                "[denext] refused a native plugin call from %@, which is not the app's origin (list it in plugins.DenextBridge.allowedOrigins)",
                from
            )
            return
        }
        target?.userContentController(userContentController, didReceive: message)
    }

    /// Logs a refusal once per origin (at most 16).
    private func refuse(_ format: String, _ from: String) {
        if logged.count < 16, logged.insert(from).inserted {
            NSLog(format, from)
        }
    }
}
`;

/**
 * `source` (a bridge view controller template without the guard) with it: `import WebKit` after
 * `import UIKit`, the install line after `super.capacitorDidLoad()`, and the guard class at the
 * end.
 *
 * @param source The Swift template.
 * @returns The guarded template.
 * @throws When `source` lacks either anchor (a template edit that would silently drop the guard).
 */
export function withFrameGuard(source: string): string {
  const importAnchor = "import UIKit\n";
  const superAnchor = "        super.capacitorDidLoad()\n";
  if (!source.includes(importAnchor) || !source.includes(superAnchor)) {
    throw new Error("the bridge view controller template has no place for the frame guard");
  }
  return source
    .replace(importAnchor, importAnchor + FRAME_GUARD_IMPORT)
    .replace(superAnchor, superAnchor + FRAME_GUARD_INSTALL) + FRAME_GUARD_SWIFT;
}
