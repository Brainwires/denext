package com.getcapacitor;

public class PluginCall {
    public final JSObject data = new JSObject();
    public JSObject resolved;
    public String rejectedCode;

    public String getString(String key) {
        Object value = data.opt(key);
        return value instanceof String ? (String) value : null;
    }

    public String getString(String key, String defaultValue) {
        String value = getString(key);
        return value == null ? defaultValue : value;
    }

    public JSObject getObject(String key) {
        Object value = data.opt(key);
        return value instanceof JSObject ? (JSObject) value : null;
    }

    public void resolve(JSObject value) {
        resolved = value;
    }

    public void reject(String message, String code) {
        rejectedCode = code;
    }
}
