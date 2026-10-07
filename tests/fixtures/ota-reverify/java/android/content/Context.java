package android.content;

public abstract class Context {
    public static final int MODE_PRIVATE = 0;

    public abstract SharedPreferences getSharedPreferences(String name, int mode);

    public abstract java.io.File getNoBackupFilesDir();

    public abstract java.io.File getFilesDir();

    public abstract android.content.pm.PackageManager getPackageManager();

    public abstract String getPackageName();

    public abstract Context getApplicationContext();

    public abstract android.content.pm.ApplicationInfo getApplicationInfo();

    public abstract android.content.res.AssetManager getAssets();
}
