// Drives the Android worker, store and plugin of denext's file transfers
// (DenextTransferWorker.java, DenextTransferStore.java, DenextTransferPlugin.java, compiled against
// the plain-JDK stand-ins in java/) with a scripted DenextTransferHttp (below) in place of the
// network, so the harness decides exactly where a cancel lands relative to the worker: during the
// download, after the move into the target but before the record says done, after done, and after
// an upload; where a pause lands (before the move, after it, then a cancel or a resume); and an id
// cancelled, forgotten and started again while its old worker is still finishing. Each cancel runs to completion at its point (a hook in the scripted HTTP half), so the
// interleaving is fixed, not timed. Prints `ok <check>` / `FAIL <check>: why`, then
// `done <failures>`.
package dev.denext.transfer;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.WorkerParameters;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONObject;

public final class TransferWorkerHarness {
    static int failures = 0;

    static void check(String name, boolean ok, String why) {
        if (ok) {
            System.out.println("ok " + name);
        } else {
            failures++;
            System.out.println("FAIL " + name + ": " + why);
        }
    }

    /** SharedPreferences as an in-memory map. */
    static final class Prefs implements SharedPreferences {
        final Map<String, String> values = new TreeMap<>();

        @Override
        public synchronized String getString(String key, String defValue) {
            String value = values.get(key);
            return value == null ? defValue : value;
        }

        @Override
        public synchronized Map<String, ?> getAll() {
            return new HashMap<>(values);
        }

        @Override
        public Editor edit() {
            Prefs prefs = this;
            Map<String, String> puts = new HashMap<>();
            java.util.List<String> removes = new java.util.ArrayList<>();
            return new Editor() {
                @Override
                public Editor putString(String key, String value) {
                    puts.put(key, value);
                    return this;
                }

                @Override
                public Editor remove(String key) {
                    removes.add(key);
                    return this;
                }

                @Override
                public void apply() {
                    synchronized (prefs) {
                        for (String key : removes) values.remove(key);
                        values.putAll(puts);
                    }
                }
            };
        }
    }

    static File root;
    static Context context;
    static DenextTransferStore store;
    static DenextTransferPlugin plugin;

    static File dataFile(String path) {
        return new File(new File(root, "files"), path);
    }

    static PluginCall call(String id) {
        PluginCall call = new PluginCall();
        call.data.put("id", id);
        return call;
    }

    /** Start a transfer through the plugin, as the page does. */
    static void start(String id, String kind, String path) {
        PluginCall call = call(id);
        call.data.put("kind", kind);
        call.data.put("url", "https://example.test/" + id);
        call.data.put("directory", "DATA");
        call.data.put("path", path);
        plugin.start(call);
        if (call.resolved == null) throw new IllegalStateException("start " + id + ": " + call.rejectedCode);
    }

    /** Run the transfer's enqueued worker on this thread; a cancel stops it, as WorkManager does. */
    static String work(String id) {
        WorkManager manager = WorkManager.getInstance(context);
        OneTimeWorkRequest request = manager.enqueued.get("denext-transfer-" + id);
        DenextTransferWorker worker = new DenextTransferWorker(context, new WorkerParameters(request.data, 0));
        manager.onCancel = worker::stop;
        try {
            return worker.doWork().toString();
        } finally {
            manager.onCancel = null;
        }
    }

    /** Cancel through the plugin; what {@code cancelFileTransfer} resolves with. */
    static boolean cancel(String id) {
        PluginCall call = call(id);
        plugin.cancel(call);
        return call.resolved != null && call.resolved.optBoolean("cancelled");
    }

    /** Pause through the plugin; what {@code pauseFileTransfer} resolves with. */
    static boolean pause(String id) {
        PluginCall call = call(id);
        plugin.pause(call);
        return call.resolved != null && call.resolved.optBoolean("paused");
    }

    /** Resume through the plugin; what {@code resumeFileTransfer} resolves with. */
    static boolean resume(String id) {
        PluginCall call = call(id);
        plugin.resume(call);
        return call.resolved != null && call.resolved.optBoolean("resumed");
    }

    /** Forget through the plugin. */
    static boolean forget(String id) {
        PluginCall call = call(id);
        plugin.forget(call);
        return call.resolved != null && call.resolved.optBoolean("forgotten");
    }

    static String state(String id) {
        JSONObject record = store.record(id);
        return record == null ? "(none)" : record.optString("state");
    }

    static boolean partLeft(File target) {
        File part = DenextTransferHttp.partFile(target);
        return part.exists() || new File(part.getPath() + ".meta").exists();
    }

    public static void main(String[] args) throws Exception {
        root = new File(args[0]);
        Environment.root = root;
        Prefs prefs = new Prefs();
        context = new Context() {
            @Override
            public Context getApplicationContext() {
                return this;
            }

            @Override
            public SharedPreferences getSharedPreferences(String name, int mode) {
                return prefs;
            }

            @Override
            public File getFilesDir() {
                return new File(root, "files");
            }

            @Override
            public File getCacheDir() {
                return new File(root, "cache");
            }

            @Override
            public File getNoBackupFilesDir() {
                return new File(root, "no-backup");
            }
        };
        plugin = new DenextTransferPlugin();
        plugin.context = context;
        plugin.load();
        store = DenextTransferStore.get(context);

        // A download that finishes: the file is there and the record says done.
        File plain = dataFile("plain.bin");
        start("plain", "download", "plain.bin");
        String result = work("plain");
        check("a finished download is done", state("plain").equals("done") && result.equals("success"),
            state("plain") + " / " + result);
        check("a finished download leaves its file", plain.isFile()
            && plain.length() == DenextTransferHttp.BODY.length, String.valueOf(plain.length()));
        check("a finished download leaves no partial file", !partLeft(plain), "part left");

        // A cancel after done: the download stays, and the cancel says it did nothing.
        check("a cancel after done answers false", !cancel("plain"), "cancelled a done transfer");
        check("a cancel after done keeps the file", plain.isFile(), "file deleted");
        check("a cancel after done keeps the record done", state("plain").equals("done"), state("plain"));

        // A cancel while the bytes arrive: the worker stops, nothing is left.
        File early = dataFile("early.bin");
        start("early", "download", "early.bin");
        boolean[] earlyCancelled = {false};
        DenextTransferHttp.onDownloaded = () -> earlyCancelled[0] = cancel("early");
        result = work("early");
        check("a cancel during the download answers true", earlyCancelled[0], "not cancelled");
        check("a cancel during the download is cancelled", state("early").equals("cancelled"), state("early"));
        check("a cancel during the download leaves no file", !early.exists() && !partLeft(early),
            "target " + early.exists() + ", part " + partLeft(early));

        // The window: a cancel after the worker moved the file into place, before it recorded done.
        File late = dataFile("dir/late.bin");
        start("late", "download", "dir/late.bin");
        boolean[] lateCancelled = {false};
        boolean[] inWindow = {false};
        DenextTransferHttp.onMoved = () -> {
            inWindow[0] = late.isFile() && !DenextTransferHttp.partFile(late).exists();
            lateCancelled[0] = cancel("late");
        };
        result = work("late");
        check("the cancel landed after the move", inWindow[0], "the target was not in place yet");
        check("a cancel after the move answers true", lateCancelled[0], "not cancelled");
        check("a cancel after the move stays cancelled", state("late").equals("cancelled"), state("late"));
        check("a cancel after the move leaves no file", !late.exists(), "the complete download is still there");
        check("a cancel after the move leaves no partial file", !partLeft(late), "part left");

        // A pause after the move is too late: the download is complete, so it ends done and the
        // pause answers false (as the web fallback's pause during the last write does).
        File pausedLate = dataFile("paused-late.bin");
        start("pl", "download", "paused-late.bin");
        boolean[] plPaused = {true};
        DenextTransferHttp.onMoved = () -> plPaused[0] = pause("pl");
        result = work("pl");
        check("a pause after the move answers false", !plPaused[0], "paused a finished download");
        check("a pause after the move ends done", state("pl").equals("done"), state("pl"));
        check("a pause after the move keeps the file", pausedLate.isFile(), "file missing");
        check("a pause after the move leaves no partial file", !partLeft(pausedLate), "part left");

        // Pause after the move, then cancel: the cancel finds the transfer done, so the file stays
        // and no cancelled transfer is left with a complete file at its path.
        File pausedCancelled = dataFile("paused-cancelled.bin");
        start("pc", "download", "paused-cancelled.bin");
        boolean[] pcPaused = {true};
        DenextTransferHttp.onMoved = () -> pcPaused[0] = pause("pc");
        result = work("pc");
        boolean pcCancelled = cancel("pc");
        check("pause then cancel after the move: the pause answers false", !pcPaused[0], "paused");
        check("pause then cancel after the move: the cancel answers false", !pcCancelled, "cancelled");
        check("pause then cancel after the move ends done", state("pc").equals("done"), state("pc"));
        check("pause then cancel after the move: no cancelled transfer keeps a file",
            !(state("pc").equals("cancelled") && pausedCancelled.exists()),
            "cancelled, with the complete download still at its path");

        // Pause after the move, then resume: nothing to resume, the transfer is done.
        File pausedResumed = dataFile("paused-resumed.bin");
        start("pr", "download", "paused-resumed.bin");
        boolean[] prPaused = {true};
        DenextTransferHttp.onMoved = () -> prPaused[0] = pause("pr");
        result = work("pr");
        boolean prResumed = resume("pr");
        check("pause then resume after the move: the pause answers false", !prPaused[0], "paused");
        check("pause then resume after the move: the resume answers false", !prResumed, "resumed");
        check("pause then resume after the move ends done", state("pr").equals("done"), state("pr"));
        check("pause then resume after the move keeps the file", pausedResumed.isFile(), "file missing");

        // A pause before the move still pauses: the partial file stays, the target is not written,
        // and a resume finishes the download.
        File pausedEarly = dataFile("paused-early.bin");
        start("pe", "download", "paused-early.bin");
        boolean[] pePaused = {false};
        DenextTransferHttp.onDownloaded = () -> pePaused[0] = pause("pe");
        result = work("pe");
        check("a pause before the move answers true", pePaused[0], "not paused");
        check("a pause before the move is paused", state("pe").equals("paused"), state("pe"));
        check("a pause before the move keeps its partial file",
            DenextTransferHttp.partFile(pausedEarly).isFile(), "no partial file");
        check("a pause before the move does not write the target", !pausedEarly.exists(), "target written");
        boolean peResumed = resume("pe");
        result = work("pe");
        check("a paused download resumes", peResumed && state("pe").equals("done"), peResumed + " / " + state("pe"));
        check("a resumed download leaves its file", pausedEarly.isFile() && !partLeft(pausedEarly),
            "target " + pausedEarly.isFile() + ", part " + partLeft(pausedEarly));

        // A run after the process died while the worker was finishing: the marker is cleared, so
        // a pause during the new download still pauses.
        File rerun = dataFile("rerun.bin");
        start("rr", "download", "rerun.bin");
        store.update("rr", "running", r -> {
            r.put("finishing", true);
            return null;
        });
        boolean[] rrPaused = {false};
        DenextTransferHttp.onDownloaded = () -> rrPaused[0] = pause("rr");
        result = work("rr");
        check("a rerun after the process died while finishing can pause", rrPaused[0]
            && state("rr").equals("paused"), rrPaused[0] + " / " + state("rr"));
        check("a rerun paused before the move does not write the target", !rerun.exists(), "target written");

        // The id reused: cancelled, forgotten and started again while the old worker is between
        // the move and its done update. The old worker leaves the new transfer alone.
        File reused = dataFile("reused.bin");
        start("re", "download", "reused.bin");
        boolean[] restarted = {false};
        DenextTransferHttp.onMoved = () -> {
            boolean c = cancel("re");
            boolean f = forget("re");
            start("re", "download", "reused.bin");
            restarted[0] = c && f;
        };
        result = work("re");
        check("the id was cancelled, forgotten and started again", restarted[0], "not restarted");
        check("an old worker does not finish the restarted transfer", state("re").equals("running"), state("re"));
        JSONObject renewed = store.record("re");
        check("an old worker does not report into the restarted transfer",
            renewed != null && "0".equals(renewed.optString("bytes")) && !renewed.has("status"),
            String.valueOf(renewed));
        JSONObject seen = renewed == null ? null : store.info(renewed);
        check("the page never sees a transfer's attempt", renewed != null && renewed.has("attempt")
            && !seen.has("attempt") && !seen.has("finishing"), String.valueOf(seen));
        result = work("re");
        check("the restarted transfer finishes", state("re").equals("done") && result.equals("success"),
            state("re") + " / " + result);
        check("the restarted transfer leaves its file", reused.isFile() && !partLeft(reused),
            "target " + reused.isFile() + ", part " + partLeft(reused));

        // An upload cancelled after it was sent: its source file is the app's, never deleted.
        File source = dataFile("source.txt");
        source.getParentFile().mkdirs();
        Files.write(source.toPath(), "the app's file".getBytes(StandardCharsets.UTF_8));
        start("up", "upload", "source.txt");
        boolean[] upCancelled = {false};
        DenextTransferHttp.onUploaded = () -> upCancelled[0] = cancel("up");
        result = work("up");
        check("a cancel after an upload was sent answers true", upCancelled[0], "not cancelled");
        check("a cancelled upload keeps its source file", source.isFile(), "the source file was deleted");

        System.out.println("done " + failures);
        System.exit(failures == 0 ? 0 : 1);
    }
}

/**
 * The HTTP half, scripted: a download writes {@link #BODY} to its partial file, an upload sends
 * nothing. The hooks run once each, at the point their name says, then clear.
 */
final class DenextTransferHttp {
    static final byte[] BODY = "denext transfer body".getBytes(StandardCharsets.UTF_8);

    /** After a download's bytes are written, before it returns (the worker has not moved them). */
    static Runnable onDownloaded;
    /** When the worker drops the partial file's metadata, which it does right after the move. */
    static Runnable onMoved;
    /** After an upload is sent, before it returns. */
    static Runnable onUploaded;

    interface Listener {
        void progress(long bytes, long total);

        boolean stopped();
    }

    static final class Result {
        final int status;
        final long bytes;
        final String body;
        final Map<String, String> headers;

        Result(int status, long bytes, String body, Map<String, String> headers) {
            this.status = status;
            this.bytes = bytes;
            this.body = body;
            this.headers = headers;
        }
    }

    static final class HttpError extends IOException {
        final int status;
        final String body;

        HttpError(int status, String body) {
            super("the server answered " + status);
            this.status = status;
            this.body = body;
        }
    }

    static final class Stopped extends IOException {
        Stopped() {
            super("stopped");
        }
    }

    static final class Multipart {
        Multipart(String field, String fileName, String mimeType, Map<String, String> fields) {}
    }

    private static void fire(boolean download, boolean moved) {
        Runnable hook;
        if (moved) {
            hook = onMoved;
            onMoved = null;
        } else if (download) {
            hook = onDownloaded;
            onDownloaded = null;
        } else {
            hook = onUploaded;
            onUploaded = null;
        }
        if (hook != null) hook.run();
    }

    static File partFile(File target) {
        return new File(target.getPath() + ".denext-part");
    }

    static File metaFile(File part) {
        if (onMoved != null && !part.exists()) fire(true, true);
        return new File(part.getPath() + ".meta");
    }

    static Result download(String url, Map<String, String> headers, File part, Listener listener)
        throws IOException {
        part.getParentFile().mkdirs();
        Files.write(part.toPath(), BODY);
        listener.progress(BODY.length, BODY.length);
        fire(true, false);
        if (listener.stopped()) throw new Stopped();
        return new Result(200, BODY.length, null, new HashMap<>());
    }

    static Result upload(
        String url,
        String method,
        Map<String, String> headers,
        File source,
        Multipart multipart,
        String mimeType,
        Listener listener
    ) throws IOException {
        long size = source.length();
        listener.progress(size, size);
        fire(false, false);
        return new Result(200, size, "ok", new HashMap<>());
    }
}
