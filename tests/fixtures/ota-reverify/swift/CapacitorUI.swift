// What DenextOtaPlugin.swift uses beyond CapacitorCore.swift (iOS only: UIKit).
import UIKit

public let CAPPluginReturnPromise = "promise"

@objc public class CAPPluginMethod: NSObject {
    public init(name: String, returnType: String) {}
}

@objc public protocol CAPBridgeProtocol: NSObjectProtocol {
    var viewController: UIViewController? { get }
    func setServerBasePath(_ path: String)
}

@objc public protocol CAPBridgedPlugin: NSObjectProtocol {
    var identifier: String { get }
    var jsName: String { get }
    var pluginMethods: [CAPPluginMethod] { get }
}

@objc open class CAPPluginCall: NSObject {
    public func getString(_ key: String) -> String? { nil }
    public func getObject(_ key: String) -> JSObject? { nil }
    public func resolve(_ data: [String: Any] = [:]) {}
    public func reject(_ message: String, _ code: String? = nil) {}
    public func reject(_ message: String, _ code: String?, _ error: Error?) {}
    public func getBool(_ key: String) -> Bool? { nil }
    public func getDouble(_ key: String) -> Double? { nil }
    public func getArray<T>(_ key: String, _ type: T.Type) -> [T]? { nil }
}

public enum JSTypes {
    public static func coerceDictionaryToJSObject(_ dictionary: [AnyHashable: Any]) -> JSObject? { nil }
}

@objc open class CAPPlugin: NSObject {
    public weak var bridge: CAPBridgeProtocol?
    open func load() {}
    public func notifyListeners(_ eventName: String, data: [String: Any]?, retainUntilConsumed: Bool) {}
}

@objc open class CAPBridgeViewController: UIViewController {
    @objc public func setServerBasePath(path: String) {}
}
