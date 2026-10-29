package android.system;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.file.attribute.FileTime;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** stat(2) through the JDK's "unix" attribute view (Linux and macOS JDKs have it). */
public final class Os {
    public static StructStat stat(String path) throws ErrnoException {
        try {
            Map<String, Object> a = Files.readAttributes(Paths.get(path), "unix:dev,ino,size,lastModifiedTime,ctime");
            return new StructStat(
                ((Number) a.get("dev")).longValue(),
                ((Number) a.get("ino")).longValue(),
                ((Number) a.get("size")).longValue(),
                ((FileTime) a.get("lastModifiedTime")).to(TimeUnit.SECONDS),
                ((FileTime) a.get("ctime")).to(TimeUnit.SECONDS)
            );
        } catch (IOException | RuntimeException ex) {
            throw new ErrnoException("stat", 2);
        }
    }
}
