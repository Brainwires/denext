package androidx.work;

import android.content.Context;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Records the unique work it is given; the harness runs the workers itself. */
public final class WorkManager {
    private static final WorkManager INSTANCE = new WorkManager();

    /** The latest request under each unique name. */
    public final Map<String, OneTimeWorkRequest> enqueued = new LinkedHashMap<>();
    /** The unique names cancelled, in order. */
    public final List<String> cancelled = new ArrayList<>();
    /** Runs on every cancel (the harness stops the running worker, as WorkManager does). */
    public Runnable onCancel;

    public static WorkManager getInstance(Context context) {
        return INSTANCE;
    }

    public void enqueueUniqueWork(String name, ExistingWorkPolicy policy, OneTimeWorkRequest request) {
        enqueued.put(name, request);
    }

    public void cancelUniqueWork(String name) {
        cancelled.add(name);
        if (onCancel != null) onCancel.run();
    }
}
