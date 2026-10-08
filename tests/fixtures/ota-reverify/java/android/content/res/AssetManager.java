package android.content.res;

public class AssetManager {
    private final java.io.File root;

    public AssetManager(java.io.File root) {
        this.root = root;
    }

    public java.io.InputStream open(String path) throws java.io.IOException {
        return new java.io.FileInputStream(new java.io.File(root, path));
    }
}
