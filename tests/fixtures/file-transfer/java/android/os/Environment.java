package android.os;

public final class Environment {
    public static final String DIRECTORY_DOCUMENTS = "Documents";

    /** Where the harness says (a temporary folder). */
    public static java.io.File root = new java.io.File(System.getProperty("java.io.tmpdir"));

    public static java.io.File getExternalStoragePublicDirectory(String type) {
        return new java.io.File(root, type);
    }
}
