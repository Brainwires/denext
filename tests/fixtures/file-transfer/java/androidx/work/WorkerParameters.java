package androidx.work;

public final class WorkerParameters {
    final Data data;
    final int runAttemptCount;

    public WorkerParameters(Data data, int runAttemptCount) {
        this.data = data;
        this.runAttemptCount = runAttemptCount;
    }
}
