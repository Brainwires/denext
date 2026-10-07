package android.os;

/** Runs posted work at once, on the caller's thread. */
public class Handler {
    public Handler(Looper looper) {}

    public boolean post(Runnable runnable) {
        runnable.run();
        return true;
    }

    public boolean postAtTime(Runnable runnable, long uptimeMillis) {
        return true;
    }

    public void removeCallbacks(Runnable runnable) {}
}
