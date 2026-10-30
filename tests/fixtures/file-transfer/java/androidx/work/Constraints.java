package androidx.work;

public final class Constraints {
    public final NetworkType networkType;

    private Constraints(NetworkType networkType) {
        this.networkType = networkType;
    }

    public static final class Builder {
        private NetworkType networkType = NetworkType.NOT_REQUIRED;

        public Builder setRequiredNetworkType(NetworkType type) {
            networkType = type;
            return this;
        }

        public Constraints build() {
            return new Constraints(networkType);
        }
    }
}
