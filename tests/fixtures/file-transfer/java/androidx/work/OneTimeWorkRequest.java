package androidx.work;

import java.util.concurrent.TimeUnit;

public final class OneTimeWorkRequest {
    public final Class<? extends ListenableWorker> worker;
    public final Data data;

    private OneTimeWorkRequest(Class<? extends ListenableWorker> worker, Data data) {
        this.worker = worker;
        this.data = data;
    }

    public static final class Builder {
        private final Class<? extends ListenableWorker> worker;
        private Data data = new Data.Builder().build();

        public Builder(Class<? extends ListenableWorker> worker) {
            this.worker = worker;
        }

        public Builder setInputData(Data data) {
            this.data = data;
            return this;
        }

        public Builder setConstraints(Constraints constraints) {
            return this;
        }

        public Builder setBackoffCriteria(BackoffPolicy policy, long delay, TimeUnit unit) {
            return this;
        }

        public Builder addTag(String tag) {
            return this;
        }

        public OneTimeWorkRequest build() {
            return new OneTimeWorkRequest(worker, data);
        }
    }
}
