package com.getcapacitor;

public class ServerPath {
    public enum PathType {
        BASE_PATH,
        ASSET_PATH
    }

    public final PathType type;
    public final String path;

    public ServerPath(PathType type, String path) {
        this.type = type;
        this.path = path;
    }
}
