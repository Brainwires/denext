package android.content;

public interface SharedPreferences {
    String getString(String key, String defValue);

    int getInt(String key, int defValue);

    long getLong(String key, long defValue);

    boolean contains(String key);

    Editor edit();

    interface Editor {
        Editor putString(String key, String value);

        Editor putInt(String key, int value);

        Editor putLong(String key, long value);

        Editor remove(String key);

        boolean commit();

        void apply();
    }
}
