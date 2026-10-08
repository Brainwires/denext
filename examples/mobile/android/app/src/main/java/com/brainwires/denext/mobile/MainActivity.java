// denext-main-activity-template: 5 sha256=2cc21543442b0d33eeee28b362b870b657190f7a15e4c7b02ef90ba881903c30
package com.brainwires.denext.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import dev.denext.contextmenu.DenextContextMenuPlugin;
import dev.denext.settings.DenextSettingsPlugin;
import androidx.activity.EdgeToEdge;
import dev.denext.sharereceive.DenextShareReceivePlugin;
import dev.denext.widgets.DenextWidgetsPlugin;
import dev.denext.authsession.DenextAuthSessionPlugin;
import dev.denext.ota.DenextOta;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // denext over-the-air UI: registers the DenextOta plugin and picks the UI to start
        // from. It must run before super.onCreate, which builds the bridge.
        DenextOta.prepare(this, bridgeBuilder);
        // denext auth sessions: registers the DenextAuthSession plugin (openAuthSession in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextAuthSessionPlugin.class);
        // denext widgets: registers the DenextWidgets plugin (setWidgetData in denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextWidgetsPlugin.class);
        // denext share target: registers the DenextShareReceive plugin (onShareReceived in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextShareReceivePlugin.class);
        // denext system bars: draw edge to edge on every Android version (15+ enforce it),
        // with transparent bars. It must run before super.onCreate.
        EdgeToEdge.enable(this);
        // denext app settings: registers the DenextSettings plugin (openAppSettings in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextSettingsPlugin.class);
        // denext native menus: registers the DenextContextMenu plugin (showContextMenu in
        // denext/mobile). It must run before super.onCreate, which builds the bridge.
        registerPlugin(DenextContextMenuPlugin.class);
        // denext: an exported page loads its own HTML (see DenextExportRoutes below).
        registerPlugin(DenextExportRoutes.class);
        super.onCreate(savedInstanceState);
        // denext: a dead WebView renderer recreates the activity instead of ending the app.
        if (bridge != null) bridge.addWebViewListener(new RendererRecovery(this));
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
