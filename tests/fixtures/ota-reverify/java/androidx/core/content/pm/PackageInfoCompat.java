package androidx.core.content.pm;

public final class PackageInfoCompat {
    public static long getLongVersionCode(android.content.pm.PackageInfo info) {
        return info.longVersionCode;
    }
}
