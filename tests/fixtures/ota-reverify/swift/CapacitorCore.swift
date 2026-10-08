// The slice of Capacitor 8's iOS API that DenextOtaStore.swift uses, as a module named Capacitor
// for a macOS build (tests/ota-reverify.test.ts runs the store there). CapacitorUI.swift adds
// what the plugin uses, for the iOS type-check.
import Foundation

public protocol JSValue {}
extension String: JSValue {}
extension Bool: JSValue {}
extension Int: JSValue {}
extension Float: JSValue {}
extension Double: JSValue {}
extension NSNumber: JSValue {}
extension NSNull: JSValue {}
extension Array: JSValue {}
extension Date: JSValue {}
extension Dictionary: JSValue where Key == String, Value == JSValue {}
public typealias JSObject = [String: JSValue]
public typealias JSArray = [JSValue]

public enum CAPLog {
    public static func print(_ items: Any...) {}
}

public protocol Router {
    func route(for path: String) -> String
    var basePath: String { get set }
}
