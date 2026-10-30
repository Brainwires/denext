package android.system;

public final class ErrnoException extends Exception {
    public ErrnoException(String functionName, int errno) {
        super(functionName + " failed: errno " + errno);
    }
}
