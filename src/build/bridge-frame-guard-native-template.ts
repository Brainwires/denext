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
// Android needs no counterpart: Capacitor 8's `MessageHandler` listens through
// `WebViewCompat.addWebMessageListener` and drops a message whose `isMainFrame` is false. Only
// its fallback (`android.useLegacyBridge`, or a WebView without WEB_MESSAGE_LISTENER) uses
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
/// Drops native bridge calls that do not come from the app's main frame.
///
/// WebKit delivers the bridge script message from every frame of the page, and Capacitor's
/// handler does not check which frame sent it, so an iframe (an embedded site, an ad, a widget)
/// could call any installed plugin. Capacitor injects its JS bridge into the main frame only,
/// so a message from another frame is never the app's own. This handler takes Capacitor's place
/// under the same name and forwards main-frame messages to it unchanged.
@MainActor
final class DenextMainFrameBridgeGuard: NSObject, WKScriptMessageHandler {
    /// The name Capacitor registers its handler under (WebViewDelegationHandler.handlerName).
    private static let handlerName = "bridge"
    /// Capacitor's own handler, which the bridge owns.
    private weak var target: WKScriptMessageHandler?
    /// The frame origins already logged, so a looping frame cannot flood the log.
    private var logged = Set<String>()

    private init(target: WKScriptMessageHandler) {
        self.target = target
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
        controller.add(DenextMainFrameBridgeGuard(target: handler), name: handlerName)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.frameInfo.isMainFrame else {
            let origin = message.frameInfo.securityOrigin
            let from = origin.host.isEmpty ? origin.protocol : "\(origin.protocol)://\(origin.host)"
            if logged.count < 16, logged.insert(from).inserted {
                NSLog("[denext] refused a native plugin call from a non-main frame (%@)", from)
            }
            return
        }
        target?.userContentController(userContentController, didReceive: message)
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
