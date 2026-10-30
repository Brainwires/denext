package androidx.work;

import java.util.HashMap;
import java.util.Map;

public final class Data {
    private final Map<String, String> values;

    private Data(Map<String, String> values) {
        this.values = values;
    }

    public String getString(String key) {
        return values.get(key);
    }

    public static final class Builder {
        private final Map<String, String> values = new HashMap<>();

        public Builder putString(String key, String value) {
            values.put(key, value);
            return this;
        }

        public Data build() {
            return new Data(new HashMap<>(values));
        }
    }
}
