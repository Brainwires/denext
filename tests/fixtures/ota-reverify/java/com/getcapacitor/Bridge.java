package com.getcapacitor;

/** What the templates read from Capacitor's Bridge: the directory served, and the builder. */
public class Bridge {
    public static final String CAPACITOR_FILE_START = "/_capacitor_file_";
    public static final String CAPACITOR_CONTENT_START = "/_capacitor_content_";
    /** "public" (the bundled assets) or an absolute directory, as the local server holds it. */
    public String served = "public";
    public int reloads = 0;

    public String getServerBasePath() {
        return served;
    }

    public void setServerBasePath(String path) {
        served = path;
        reloads++;
    }

    public void setServerAssetPath(String path) {
        served = path;
        reloads++;
    }

    public static class Builder {
        public RouteProcessor routeProcessor;
        public ServerPath serverPath;
        public final java.util.List<Class<? extends Plugin>> plugins = new java.util.ArrayList<>();

        public Builder addPlugin(Class<? extends Plugin> plugin) {
            plugins.add(plugin);
            return this;
        }

        public Builder setRouteProcessor(RouteProcessor routeProcessor) {
            this.routeProcessor = routeProcessor;
            return this;
        }

        public Builder setServerPath(ServerPath serverPath) {
            this.serverPath = serverPath;
            return this;
        }
    }
}
