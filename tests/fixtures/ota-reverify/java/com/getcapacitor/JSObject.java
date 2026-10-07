package com.getcapacitor;

/** Capacitor's JSONObject whose put never throws. */
public class JSObject extends org.json.JSONObject {
    @Override
    public JSObject put(String key, Object value) {
        set(key, value);
        return this;
    }

    @Override
    public JSObject put(String key, boolean value) {
        set(key, value);
        return this;
    }

    @Override
    public JSObject put(String key, int value) {
        set(key, value);
        return this;
    }

    @Override
    public JSObject put(String key, long value) {
        set(key, value);
        return this;
    }
}
