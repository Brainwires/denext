package com.getcapacitor;

public class PluginCall {
    public final JSObject data = new JSObject();
    public JSObject resolved;
    public String rejectedCode;

    public String getString(String key) {
        Object value = data.opt(key);
        return value instanceof String ? (String) value : null;
    }

    public JSObject getObject(String key) {
        return getObject(key, null);
    }

    public JSObject getObject(String key, JSObject defaultValue) {
        Object value = data.opt(key);
        return value instanceof JSObject ? (JSObject) value : defaultValue;
    }

    public void resolve() {
        resolved = new JSObject();
    }

    public void resolve(JSObject value) {
        resolved = value;
    }

    public void reject(String message, String code) {
        rejectedCode = code;
    }
}
