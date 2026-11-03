package com.getcapacitor;

/** Capacitor's JSONObject whose put never throws. */
public class JSObject extends org.json.JSONObject {
    public static JSObject fromJSONObject(org.json.JSONObject object) throws org.json.JSONException {
        JSObject out = new JSObject();
        for (java.util.Iterator<String> keys = object.keys(); keys.hasNext();) {
            String key = keys.next();
            out.set(key, object.get(key));
        }
        return out;
    }

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
