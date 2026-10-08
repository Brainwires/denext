package android.os;

public class Bundle {
    private final java.util.Map<String, Object> values = new java.util.HashMap<>();

    public Object get(String key) {
        return values.get(key);
    }

    public void putString(String key, String value) {
        values.put(key, value);
    }
}
