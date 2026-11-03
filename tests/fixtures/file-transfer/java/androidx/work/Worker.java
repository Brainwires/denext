package androidx.work;

import android.content.Context;

public abstract class Worker extends ListenableWorker {
    public Worker(Context context, WorkerParameters params) {
        super(context, params);
    }

    public abstract Result doWork();
}
