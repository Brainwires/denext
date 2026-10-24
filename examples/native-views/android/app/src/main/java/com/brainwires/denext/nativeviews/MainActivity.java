// denext-main-activity-template: 6 sha256=b324d3270df8988e0a2b154e467eefad58f40178720912fcde400e6ee4584697
package com.brainwires.denext.nativeviews;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.denext.contextmenu.DenextContextMenuPlugin;
import dev.denext.storage.DenextStoragePlugin;
import dev.denext.nativemodules.DenextNativeModules;
import dev.denext.nativeviews.DenextNativeViewsPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // denext native views: registers the DenextNativeViews plugin (NativeViewSlot in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextNativeViewsPlugin.class);
        // The app's own native modules (denext mobile add native-module). It must run
        // before super.onCreate, which builds the bridge.
        DenextNativeModules.register(this);
        // denext durable storage: registers the DenextStorage plugin (openKeyValueStore in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextStoragePlugin.class);
        // denext native menus: registers the DenextContextMenu plugin (showContextMenu in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextContextMenuPlugin.class);
        // denext: an exported page loads its own HTML (see DenextExportRoutes below).
        registerPlugin(DenextExportRoutes.class);
        super.onCreate(savedInstanceState);
        // denext: a dead WebView renderer recreates the activity instead of ending the app.
        if (bridge != null) bridge.addWebViewListener(new RendererRecovery(this));
        // denext: native plugin calls only from the app's own origin (see BridgeOriginGuard).
        if (bridge != null) BridgeOriginGuard.install(this, bridge);
    }

    /**
     * denext: when the WebView's renderer process dies, Android ends the app unless the WebView
     * client handles it. This drops the dead WebView (it cannot be used again) and recreates the
     * activity, which builds a new bridge and WebView and loads the page again. A renderer that
     * dies three times within a minute is left to end the app.
     */
    private static final class RendererRecovery extends com.getcapacitor.WebViewListener {
        private static final int MAX_RECOVERIES = 3;
        private static final long WINDOW_MS = 60_000;
        /** When the renderer died recently (elapsed realtime); survives the recreated activity. */
        private static final java.util.ArrayDeque<Long> RECENT = new java.util.ArrayDeque<>();
        private final android.app.Activity activity;

        RendererRecovery(android.app.Activity activity) {
            this.activity = activity;
        }

        @Override
        public boolean onRenderProcessGone(android.webkit.WebView webView, android.webkit.RenderProcessGoneDetail detail) {
            long now = android.os.SystemClock.elapsedRealtime();
            while (!RECENT.isEmpty() && now - RECENT.peekFirst() > WINDOW_MS) RECENT.pollFirst();
            boolean crashed = android.os.Build.VERSION.SDK_INT >= 26 && detail != null && detail.didCrash();
            String cause = crashed ? "crashed" : "was killed by the system";
            if (RECENT.size() >= MAX_RECOVERIES) {
                android.util.Log.e("denext", "WebView renderer " + cause + " again; not recovering");
                return false;
            }
            RECENT.addLast(now);
            android.util.Log.w("denext", "WebView renderer " + cause + "; recreating the activity");
            if (webView.getParent() instanceof android.view.ViewGroup) {
                ((android.view.ViewGroup) webView.getParent()).removeView(webView);
            }
            webView.destroy();
            if (!activity.isFinishing()) activity.recreate();
            return true;
        }
    }

    /**
     * denext: the OS is low on memory. The page receives the "denext:memorywarning" window
     * event, which React Native mode's AppState emits as "memoryWarning".
     */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (isMemoryWarning(level)) memoryWarning();
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        memoryWarning();
    }

    /**
     * Whether onTrimMemory's level is a shortage worth telling the page about: TRIM_MEMORY_RUNNING_LOW
     * (10) and above, except TRIM_MEMORY_UI_HIDDEN (20). Literals: API 34 deprecates the constants.
     */
    static boolean isMemoryWarning(int level) {
        return level >= 10 && level != 20;
    }

    private void memoryWarning() {
        if (bridge != null) bridge.triggerWindowJSEvent("denext:memorywarning");
    }

    /**
     * denext: native plugin calls only from the app's own origin. Capacitor gives its bridge to
     * every server.url and server.allowNavigation origin; this narrows it to the app's local
     * origin (plus server.url in a debuggable build, for live reload) and the Capacitor config's
     * plugins.DenextBridge.allowedOrigins. plugins.DenextBridge.frameGuard: false turns it off.
     */
    static final class BridgeOriginGuard {
        private static final String BRIDGE_NAME = "androidBridge";

        static void install(android.app.Activity activity, com.getcapacitor.Bridge bridge) {
            com.getcapacitor.PluginConfig config = bridge.getConfig().getPluginConfiguration("DenextBridge");
            if (!config.getBoolean("frameGuard", true)) return;
            if (
                bridge.getConfig().isUsingLegacyBridge() ||
                !androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_MESSAGE_LISTENER)
            ) {
                android.util.Log.w("denext", "the native bridge is not limited to the app's origin: the legacy bridge is in use");
                return;
            }
            final com.getcapacitor.MessageHandler handler = messageHandler(bridge);
            if (handler == null) {
                android.util.Log.w("denext", "the native bridge is not limited to the app's origin: no MessageHandler found");
                return;
            }
            android.webkit.WebView webView = bridge.getWebView();
            androidx.webkit.WebViewCompat.WebMessageListener listener = (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                String data = message.getData();
                if (isMainFrame && data != null) {
                    handler.postMessage(data);
                } else {
                    android.util.Log.w("denext", "refused a native plugin call from a frame that is not the main one");
                }
            };
            androidx.webkit.WebViewCompat.removeWebMessageListener(webView, BRIDGE_NAME);
            try {
                androidx.webkit.WebViewCompat.addWebMessageListener(webView, BRIDGE_NAME, allowedOrigins(activity, bridge, config), listener);
            } catch (RuntimeException e) {
                // A rule WebView refused (a malformed allowedOrigins entry): the app's own origin alone.
                android.util.Log.e("denext", "plugins.DenextBridge.allowedOrigins was refused: " + e.getMessage());
                androidx.webkit.WebViewCompat.addWebMessageListener(
                    webView,
                    BRIDGE_NAME,
                    java.util.Collections.singleton(localOrigin(bridge)),
                    listener
                );
            }
        }

        /** The origins plugin calls are accepted from. */
        static java.util.Set<String> allowedOrigins(
            android.app.Activity activity,
            com.getcapacitor.Bridge bridge,
            com.getcapacitor.PluginConfig config
        ) {
            java.util.Set<String> rules = new java.util.LinkedHashSet<>();
            rules.add(localOrigin(bridge));
            boolean debuggable = (activity.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            String server = debuggable ? origin(bridge.getServerUrl()) : null;
            if (server != null) rules.add(server);
            for (String entry : config.getArray("allowedOrigins", new String[0])) {
                String allowed = origin(entry);
                if (allowed != null) rules.add(allowed);
            }
            return rules;
        }

        /** The origin Capacitor's local server answers on (https://localhost by default). */
        static String localOrigin(com.getcapacitor.Bridge bridge) {
            return bridge.getScheme() + "://" + bridge.getHost();
        }

        /** {@code scheme://host[:port]} of {@code url} (lower-cased), or null. */
        static String origin(String url) {
            if (url == null) return null;
            android.net.Uri uri = android.net.Uri.parse(url);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null || host.isEmpty() || uri.getUserInfo() != null) return null;
            int port = uri.getPort();
            return scheme.toLowerCase(java.util.Locale.ROOT) + "://" + host.toLowerCase(java.util.Locale.ROOT) +
                (port == -1 ? "" : ":" + port);
        }

        /** Capacitor's MessageHandler, which the bridge keeps in a private field (found by type). */
        static com.getcapacitor.MessageHandler messageHandler(com.getcapacitor.Bridge bridge) {
            for (java.lang.reflect.Field field : com.getcapacitor.Bridge.class.getDeclaredFields()) {
                if (field.getType() != com.getcapacitor.MessageHandler.class) continue;
                try {
                    field.setAccessible(true);
                    return (com.getcapacitor.MessageHandler) field.get(bridge);
                } catch (Exception e) {
                    return null;
                }
            }
            return null;
        }
    }

    /**
     * denext: an exported multi-page app's routes load their own pages. Capacitor's local server
     * answers every path without an extension with the root index.html, so a link to /protected
     * would load the home page. Loaded with the bridge, before the first page, this puts
     * ExportRoutesClient in front of the bridge's WebViewClient.
     */
    @com.getcapacitor.annotation.CapacitorPlugin(name = "DenextExportRoutes")
    public static final class DenextExportRoutes extends com.getcapacitor.Plugin {
        @Override
        public void load() {
            com.getcapacitor.Bridge bridge = getBridge();
            com.getcapacitor.BridgeWebViewClient current = bridge.getWebViewClient();
            if (current != null && current.getClass() != com.getcapacitor.BridgeWebViewClient.class) {
                android.util.Log.w("denext", "the app has its own WebViewClient; exported pages route as a single-page app");
                return;
            }
            bridge.setWebViewClient(new ExportRoutesClient(bridge));
        }
    }

    /**
     * Asks the local server for /route/index.html or /route.html instead of /route when the UI
     * served (the bundled public/ assets or an over-the-air UI directory) has that page. Every
     * other request keeps Capacitor's answer.
     */
    private static final class ExportRoutesClient extends com.getcapacitor.BridgeWebViewClient {
        private final com.getcapacitor.Bridge bridge;

        ExportRoutesClient(com.getcapacitor.Bridge bridge) {
            super(bridge);
            this.bridge = bridge;
        }

        @Override
        public android.webkit.WebResourceResponse shouldInterceptRequest(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
            String page = exportedPage(request.getUrl());
            return super.shouldInterceptRequest(view, page == null ? request : new Rerouted(request, page));
        }

        /** The exported page behind an extensionless local path, or null to leave the request alone. */
        private String exportedPage(android.net.Uri url) {
            // Live reload (server.url): the dev server routes the pages itself.
            if (bridge.getServerUrl() != null) return null;
            String host = url.getHost();
            String path = url.getPath();
            if (host == null || path == null || !host.equalsIgnoreCase(bridge.getHost())) return null;
            if (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            String last = path.substring(path.lastIndexOf('/') + 1);
            if (last.isEmpty() || last.contains(".") || path.contains("/..") || path.startsWith("/_capacitor_")) {
                return null;
            }
            String base = bridge.getServerBasePath();
            if (base == null) return null;
            for (String page : new String[] { path + "/index.html", path + ".html" }) {
                if (exists(base, page)) return page;
            }
            return null;
        }

        /** Whether the UI served has page: a file under an absolute base (an over-the-air UI), else an asset. */
        private boolean exists(String base, String page) {
            if (base.startsWith("/")) return new java.io.File(base + page).isFile();
            try (java.io.InputStream in = bridge.getContext().getAssets().open(base + page)) {
                return true;
            } catch (java.io.IOException e) {
                return false;
            }
        }
    }

    /** A request for another path of the same URL (the WebView still shows the URL it asked for). */
    private static final class Rerouted implements android.webkit.WebResourceRequest {
        private final android.webkit.WebResourceRequest request;
        private final android.net.Uri url;

        Rerouted(android.webkit.WebResourceRequest request, String path) {
            this.request = request;
            this.url = request.getUrl().buildUpon().path(path).build();
        }

        @Override
        public android.net.Uri getUrl() {
            return url;
        }

        @Override
        public boolean isForMainFrame() {
            return request.isForMainFrame();
        }

        @Override
        public boolean isRedirect() {
            return request.isRedirect();
        }

        @Override
        public boolean hasGesture() {
            return request.hasGesture();
        }

        @Override
        public String getMethod() {
            return request.getMethod();
        }

        @Override
        public java.util.Map<String, String> getRequestHeaders() {
            return request.getRequestHeaders();
        }
    }
}
