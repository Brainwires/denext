package org.json;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/** org.json's object over a small JSON reader and writer (the subset the templates use). */
public class JSONObject {
    public static final Object NULL = new Object() {
        @Override
        public String toString() {
            return "null";
        }
    };

    final Map<String, Object> values = new LinkedHashMap<>();

    public JSONObject() {}

    public JSONObject(String text) throws JSONException {
        Reader reader = new Reader(text);
        Object value = reader.value();
        reader.end();
        if (!(value instanceof JSONObject)) throw new JSONException("not an object");
        values.putAll(((JSONObject) value).values);
    }

    protected void set(String key, Object value) {
        values.put(key, value == null ? NULL : value);
    }

    public JSONObject put(String key, Object value) throws JSONException {
        set(key, value);
        return this;
    }

    public JSONObject put(String key, boolean value) throws JSONException {
        set(key, value);
        return this;
    }

    public JSONObject put(String key, int value) throws JSONException {
        set(key, value);
        return this;
    }

    public JSONObject put(String key, long value) throws JSONException {
        set(key, value);
        return this;
    }

    public Object opt(String key) {
        return values.get(key);
    }

    public String optString(String key, String fallback) {
        Object value = values.get(key);
        return value == null || value == NULL ? fallback : String.valueOf(value);
    }

    public JSONArray optJSONArray(String key) {
        Object value = values.get(key);
        return value instanceof JSONArray ? (JSONArray) value : null;
    }

    public JSONObject optJSONObject(String key) {
        Object value = values.get(key);
        return value instanceof JSONObject ? (JSONObject) value : null;
    }

    public Iterator<String> keys() {
        return values.keySet().iterator();
    }

    @Override
    public String toString() {
        StringBuilder out = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> entry : values.entrySet()) {
            if (!first) out.append(',');
            first = false;
            out.append(quote(entry.getKey())).append(':').append(write(entry.getValue()));
        }
        return out.append('}').toString();
    }

    static String write(Object value) {
        if (value instanceof String) return quote((String) value);
        return String.valueOf(value);
    }

    static String quote(String text) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : text.toCharArray()) {
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    /** A strict-enough JSON reader: objects, arrays, strings, numbers, booleans, null. */
    static final class Reader {
        private final String text;
        private int at = 0;

        Reader(String text) {
            this.text = text;
        }

        void end() throws JSONException {
            space();
            if (at != text.length()) throw new JSONException("trailing text at " + at);
        }

        private void space() {
            while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++;
        }

        private char next() throws JSONException {
            if (at >= text.length()) throw new JSONException("unexpected end");
            return text.charAt(at++);
        }

        Object value() throws JSONException {
            space();
            char c = next();
            if (c == '{') {
                JSONObject object = new JSONObject();
                space();
                if (text.charAt(at) == '}') {
                    at++;
                    return object;
                }
                while (true) {
                    space();
                    if (next() != '"') throw new JSONException("key expected at " + at);
                    String key = string();
                    space();
                    if (next() != ':') throw new JSONException("':' expected at " + at);
                    object.set(key, value());
                    space();
                    char d = next();
                    if (d == '}') return object;
                    if (d != ',') throw new JSONException("',' expected at " + at);
                }
            }
            if (c == '[') {
                JSONArray array = new JSONArray();
                space();
                if (text.charAt(at) == ']') {
                    at++;
                    return array;
                }
                while (true) {
                    array.put(value());
                    space();
                    char d = next();
                    if (d == ']') return array;
                    if (d != ',') throw new JSONException("',' expected at " + at);
                }
            }
            if (c == '"') return string();
            if (text.startsWith("true", at - 1)) {
                at += 3;
                return Boolean.TRUE;
            }
            if (text.startsWith("false", at - 1)) {
                at += 4;
                return Boolean.FALSE;
            }
            if (text.startsWith("null", at - 1)) {
                at += 3;
                return NULL;
            }
            int start = at - 1;
            while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
            String number = text.substring(start, at);
            try {
                if (number.matches("-?\\d+")) return Long.parseLong(number);
                return Double.parseDouble(number);
            } catch (NumberFormatException ex) {
                throw new JSONException("bad value at " + start);
            }
        }

        private String string() throws JSONException {
            StringBuilder out = new StringBuilder();
            while (true) {
                char c = next();
                if (c == '"') return out.toString();
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                char e = next();
                switch (e) {
                    case 'n': out.append('\n'); break;
                    case 't': out.append('\t'); break;
                    case 'r': out.append('\r'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'u':
                        out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
                        at += 4;
                        break;
                    default: out.append(e);
                }
            }
        }
    }
}
