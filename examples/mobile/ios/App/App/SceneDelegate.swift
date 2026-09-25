import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = DenextBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        denextForwardQuickAction(connectionOptions.shortcutItem)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        denextForwardQuickAction(shortcutItem)
        completionHandler(true)
    }

    /// denext mobile add quick-actions: hand a home-screen quick action to the AppShortcuts plugin,
    /// after the Capacitor bridge (and so the plugin) has loaded when it cold-started the app.
    private func denextForwardQuickAction(_ shortcutItem: UIApplicationShortcutItem?) {
        guard let shortcutItem else { return }
        let post = {
            NotificationCenter.default.post(name: NSNotification.Name("handleAppShortcutNotification"), object: nil, userInfo: ["shortcutItem": shortcutItem])
        }
        if (window?.rootViewController as? CAPBridgeViewController)?.bridge != nil { return post() }
        final class Observer: @unchecked Sendable { var token: NSObjectProtocol? }
        let observer = Observer()
        observer.token = NotificationCenter.default.addObserver(forName: .capacitorViewDidAppear, object: nil, queue: .main) { _ in
            guard let token = observer.token else { return }
            NotificationCenter.default.removeObserver(token)
            observer.token = nil
            post()
        }
    }
}
