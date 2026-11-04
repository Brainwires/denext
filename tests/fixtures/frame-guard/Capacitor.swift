// The slice of Capacitor 8's iOS API the bridge's frame guard uses
// (src/build/bridge-frame-guard-native-template.ts), as a module named Capacitor for an iOS
// type-check (tests/mobile-bridge-frame-guard.test.ts). Shapes as in @capacitor/ios 8.
import Foundation
import WebKit

public protocol JSValue {}
extension String: JSValue {}
public typealias JSArray = [JSValue]

@objc public protocol CAPBridgeProtocol: NSObjectProtocol {}

@objc public class PluginConfig: NSObject {
    @objc public func getBoolean(_ configKey: String, _ defaultValue: Bool) -> Bool { defaultValue }
    public func getArray(_ configKey: String, _ defaultValue: JSArray? = nil) -> JSArray? { defaultValue }
}

@objc public class InstanceConfiguration: NSObject {
    @objc public var localURL: URL { URL(string: "capacitor://localhost")! }
    @objc public var serverURL: URL { URL(string: "capacitor://localhost")! }
    @objc public func getPluginConfig(_ pluginId: String) -> PluginConfig { PluginConfig() }
}

open class WebViewDelegationHandler: NSObject, WKScriptMessageHandler {
    public var contentController = WKUserContentController()
    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {}
}

open class CapacitorBridge: NSObject, CAPBridgeProtocol {
    public let webViewDelegationHandler = WebViewDelegationHandler()
    public var config: InstanceConfiguration { InstanceConfiguration() }
}
