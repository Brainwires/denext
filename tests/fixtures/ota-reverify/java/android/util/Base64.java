package android.util;

public final class Base64 {
    public static final int DEFAULT = 0;

    public static byte[] decode(String text, int flags) {
        try {
            return java.util.Base64.getMimeDecoder().decode(text);
        } catch (IllegalArgumentException ex) {
            throw new IllegalArgumentException("bad base-64", ex);
        }
    }
}
