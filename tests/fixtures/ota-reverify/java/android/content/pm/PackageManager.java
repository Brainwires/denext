package android.content.pm;

public class PackageManager {
    public static final int GET_META_DATA = 128;
    public ApplicationInfo applicationInfo = new ApplicationInfo();
    public PackageInfo packageInfo = new PackageInfo();

    public ApplicationInfo getApplicationInfo(String packageName, int flags) throws NameNotFoundException {
        return applicationInfo;
    }

    public PackageInfo getPackageInfo(String packageName, int flags) throws NameNotFoundException {
        return packageInfo;
    }

    public static class NameNotFoundException extends Exception {}
}
