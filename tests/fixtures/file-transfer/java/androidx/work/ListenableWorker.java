package androidx.work;

import android.content.Context;

public abstract class ListenableWorker {
    private final Context context;
    private final WorkerParameters params;
    private volatile boolean stopped = false;

    protected ListenableWorker(Context context, WorkerParameters params) {
        this.context = context;
        this.params = params;
    }

    public final Context getApplicationContext() {
        return context.getApplicationContext();
    }

    public final Data getInputData() {
        return params.data;
    }

    public final int getRunAttemptCount() {
        return params.runAttemptCount;
    }

    public final boolean isStopped() {
        return stopped;
    }

    /** What WorkManager does to a cancelled unique work: the worker sees isStopped(). */
    public final void stop() {
        stopped = true;
    }

    public static class Result {
        public final String kind;

        private Result(String kind) {
            this.kind = kind;
        }

        public static Result success() {
            return new Result("success");
        }

        public static Result failure() {
            return new Result("failure");
        }

        public static Result retry() {
            return new Result("retry");
        }

        @Override
        public String toString() {
            return kind;
        }
    }
}
