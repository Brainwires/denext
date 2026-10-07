package com.getcapacitor;

public class Plugin {
    public android.content.Context context;
    public Bridge bridge;
    public final java.util.List<String> events = new java.util.ArrayList<>();

    public android.content.Context getContext() {
        return context;
    }

    public Bridge getBridge() {
        return bridge;
    }

    public void load() {}

    protected void handleOnPause() {}

    protected void handleOnResume() {}

    protected void handleOnDestroy() {}

    protected void notifyListeners(String eventName, JSObject data, boolean retainUntilConsumed) {
        events.add(eventName + " " + data + " " + retainUntilConsumed);
    }
}
