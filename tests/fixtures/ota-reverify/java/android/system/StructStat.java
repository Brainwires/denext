package android.system;

/** The fields of Android's StructStat the templates read; the times are whole seconds, as there. */
public final class StructStat {
    public final long st_dev;
    public final long st_ino;
    public final long st_size;
    public final long st_mtime;
    public final long st_ctime;

    StructStat(long dev, long ino, long size, long mtime, long ctime) {
        st_dev = dev;
        st_ino = ino;
        st_size = size;
        st_mtime = mtime;
        st_ctime = ctime;
    }
}
