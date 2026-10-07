// The low-memory forwarder every generated `DenextBridgeViewController.swift` carries (the OTA
// one, the auth-session registering-only one and the app-extension registering-only one, and
// every composition), embedded as text so it ships inside the JSR package.
//
// iOS posts `UIApplication.didReceiveMemoryWarningNotification` when the app is low on memory.
// A WKWebView page gets no such signal, so React Native mode's `AppState` could not emit React
// Native's `memoryWarning`. `DenextMemoryWarning.install(on:)`, called from `capacitorDidLoad()`,
// observes the notification and fires the `denext:memorywarning` window event in the page
// (Capacitor's `triggerWindowJSEvent`), which `AppState` turns into `memoryWarning`
// (src/react-native/app-state.ts, `MEMORY_WARNING_EVENT`).
//
// Android's counterpart is part of the composed MainActivity (`MEMORY_WARNING` in
// mobile-native-install.ts: `onTrimMemory` / `onLowMemory`).
//
// Edit this as source: it is compiled only in an app; tests/react-native-memory-warning.test.ts
// type-checks it against a Capacitor stub with the iOS SDK where one exists. It is a
// `String.raw` literal (it holds no backtick).

/** The window event the page receives (the same name as `MEMORY_WARNING_EVENT` in app-state.ts). */
export const NATIVE_MEMORY_WARNING_EVENT = "denext:memorywarning";

/** The line that installs the forwarder, right after `super.capacitorDidLoad()`. */
export const MEMORY_WARNING_INSTALL =
  "        // denext: the OS's low-memory warning reaches the page (AppState's memoryWarning).\n" +
  "        DenextMemoryWarning.install(on: bridge)\n";

/** The forwarder, appended to the bridge view controller's file. */
export const MEMORY_WARNING_SWIFT = String.raw`
/// Forwards the OS's low-memory warning to the page as the "${NATIVE_MEMORY_WARNING_EVENT}" window
/// event, which React Native mode's AppState emits as "memoryWarning".
@MainActor
enum DenextMemoryWarning {
    /// The notification observer (one per process: a recreated bridge replaces it).
    private static var observer: NSObjectProtocol?

    /// Observes UIApplication.didReceiveMemoryWarningNotification for the bridge's page. Call
    /// it from capacitorDidLoad().
    static func install(on bridge: CAPBridgeProtocol?) {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak bridge] _ in
            MainActor.assumeIsolated {
                bridge?.triggerWindowJSEvent(eventName: "${NATIVE_MEMORY_WARNING_EVENT}")
            }
        }
    }
}
`;

/**
 * `source` (a bridge view controller template) with the forwarder: the install line right
 * after `super.capacitorDidLoad()` and the forwarder at the end.
 *
 * @param source The Swift template.
 * @returns The template with the forwarder.
 * @throws When `source` has no `super.capacitorDidLoad()` line (a template edit that would
 * silently drop it).
 */
export function withMemoryWarning(source: string): string {
  const superAnchor = "        super.capacitorDidLoad()\n";
  if (!source.includes(superAnchor)) {
    throw new Error("the bridge view controller template has no place for the memory warning");
  }
  return source.replace(superAnchor, superAnchor + MEMORY_WARNING_INSTALL) + MEMORY_WARNING_SWIFT;
}
