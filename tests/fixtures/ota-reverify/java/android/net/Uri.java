package android.net;

public final class Uri {
    private final java.net.URI uri;

    private Uri(java.net.URI uri) {
        this.uri = uri;
    }

    public static Uri parse(String text) {
        return new Uri(java.net.URI.create(text));
    }

    public String getScheme() {
        return uri.getScheme();
    }

    public String getHost() {
        return uri.getHost();
    }

    public int getPort() {
        return uri.getPort();
    }

    public String getPath() {
        return uri.getPath();
    }

    public Builder buildUpon() {
        return new Builder(uri.toString());
    }

    @Override
    public String toString() {
        return uri.toString();
    }

    public static final class Builder {
        private final StringBuilder text;

        Builder(String base) {
            this.text = new StringBuilder(base);
        }

        public Builder appendPath(String segment) {
            if (text.charAt(text.length() - 1) != '/') text.append('/');
            text.append(segment);
            return this;
        }

        public Uri build() {
            return Uri.parse(text.toString());
        }
    }
}
