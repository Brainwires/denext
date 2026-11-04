package com.getcapacitor;

public class Plugin {
    public android.content.Context context;
    public final java.util.List<String> events = new java.util.ArrayList<>();

    public android.content.Context getContext() {
        return context;
    }

    public void load() {}

    protected void handleOnDestroy() {}

    protected void notifyListeners(String eventName, JSObject data) {
        events.add(eventName + " " + data);
    }
}
