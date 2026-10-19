// The slice of Capacitor 8's iOS API that denext's own plugins use (DenextTransfer,
// DenextStorage, DenextSettings), as a module named Capacitor: the iOS type-checks in
// tests/mobile-native-swift.test.ts compile each plugin against it and the iOS SDK.
import UIKit

public protocol JSValue {}
extension String: JSValue {}
extension Bool: JSValue {}
extension Int: JSValue {}
extension Int64: JSValue {}
extension Float: JSValue {}
extension Double: JSValue {}
extension NSNumber: JSValue {}
extension NSNull: JSValue {}
extension Array: JSValue {}
extension Date: JSValue {}
extension Dictionary: JSValue where Key == String, Value == JSValue {}
public typealias JSObject = [String: JSValue]
public typealias JSArray = [JSValue]

public let CAPPluginReturnPromise = "promise"

@objc public class CAPPluginMethod: NSObject {
    public init(name: String, returnType: String) {}
}

@objc public protocol CAPBridgeProtocol: NSObjectProtocol {
    var viewController: UIViewController? { get }
}

@objc public protocol CAPBridgedPlugin: NSObjectProtocol {
    var identifier: String { get }
    var jsName: String { get }
    var pluginMethods: [CAPPluginMethod] { get }
}

@objc open class CAPPluginCall: NSObject {
    public func getString(_ key: String) -> String? { nil }
    public func getBool(_ key: String) -> Bool? { nil }
    public func getInt(_ key: String) -> Int? { nil }
    public func getDouble(_ key: String) -> Double? { nil }
    public func getArray(_ key: String) -> JSArray? { nil }
    public func getObject(_ key: String) -> JSObject? { nil }
    public func resolve(_ data: [String: Any] = [:]) {}
    public func reject(_ message: String, _ code: String? = nil) {}
}

@objc open class CAPPlugin: NSObject {
    public weak var bridge: CAPBridgeProtocol?
    open func load() {}
    public func notifyListeners(_ eventName: String, data: [String: Any]?) {}
    public func notifyListeners(_ eventName: String, data: [String: Any]?, retainUntilConsumed: Bool) {}
}
