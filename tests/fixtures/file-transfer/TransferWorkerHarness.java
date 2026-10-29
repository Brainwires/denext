// Drives the Android worker, store and plugin of denext's file transfers
// (DenextTransferWorker.java, DenextTransferStore.java, DenextTransferPlugin.java, compiled against
// the plain-JDK stand-ins in java/) with a scripted DenextTransferHttp (below) in place of the
// network, so the harness decides exactly where a cancel lands relative to the worker: during the
// download, after the move into the target but before the record says done, after done, and after
// an upload; where a pause lands (before the move, after it, then a cancel or a resume); an id
// cancelled, forgotten and started again while its old worker is still finishing, has not opened
// its partial file yet, or is long stopped; a start between a cancel's state change and its
// cleanup; records and work from before attempts; and a start's cleanup of dead attempts'
// partial files. Each step runs to completion at its point (a hook in the scripted HTTP half or
// in WorkManager's cancel), so the interleaving is fixed, not timed. Prints `ok <check>` / `FAIL <check>: why`, then
// `done <failures>`.
package dev.denext.transfer;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;
import androidx.work.Data;
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

    /** The partial files (and validators) beside {@code target}, of any attempt. */
    static String[] parts(File target) {
        String prefix = target.getName() + ".";
        String[] names = target.getParentFile().list((dir, name) -> name.startsWith(prefix)
            && (name.endsWith(".denext-part") || name.endsWith(".denext-part.meta")));
        return names == null ? new String[0] : names;
    }

    static boolean partLeft(File target) {
        return parts(target).length > 0;
    }

    /** A record of {@code id} as one written before attempts: no attempt token. */
    static void putLegacy(String id, String path, String state) throws Exception {
        JSONObject record = new JSONObject();
        record.put("id", id);
        record.put("kind", "download");
        record.put("url", "https://example.test/" + id);
        record.put("directory", "DATA");
        record.put("path", path);
        record.put("method", "GET");
        record.put("state", state);
        record.put("bytes", state.equals("paused") ? DenextTransferHttp.BODY.length : 0);
        record.put("resumable", state.equals("paused"));
        store.put(record);
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
            inWindow[0] = late.isFile() && !partLeft(late);
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
        check("a pause before the move keeps its partial file", partLeft(pausedEarly), "no partial file");
        check("a pause before the move does not write the target", !pausedEarly.exists(), "target written");
        boolean peResumed = resume("pe");
        DenextTransferHttp.found = null;
        result = work("pe");
        check("a resume continues from the paused attempt's partial file",
            java.util.Arrays.equals(DenextTransferHttp.found, DenextTransferHttp.BODY),
            "found " + (DenextTransferHttp.found == null ? "nothing" : DenextTransferHttp.found.length + " bytes"));
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

        // A long-stopped old worker: the id is cancelled, forgotten, started again, finished and
        // forgotten again while the first worker is still between its move and its done update.
        // Nothing then names that worker's transfer, and the file at the path is the later one's.
        File longStopped = dataFile("long-stopped.bin");
        start("ls", "download", "long-stopped.bin");
        boolean[] lsRestarted = {false};
        DenextTransferHttp.onMoved = () -> {
            boolean c = cancel("ls");
            boolean f = forget("ls");
            start("ls", "download", "long-stopped.bin");
            String later = work("ls");
            lsRestarted[0] = c && f && state("ls").equals("done") && later.equals("success")
                && longStopped.isFile() && forget("ls");
        };
        result = work("ls");
        check("the id was finished and forgotten again under the old worker", lsRestarted[0], "not restarted");
        check("a long-stopped old worker leaves the later transfer's file", longStopped.isFile()
            && longStopped.length() == DenextTransferHttp.BODY.length, "the later download was deleted");
        check("a long-stopped old worker leaves no partial file", !partLeft(longStopped),
            String.join(", ", parts(longStopped)));

        // An old worker that has not opened its partial file yet when the id is cancelled, forgotten
        // and started again (the new transfer then paused with its bytes): it writes into a file of
        // its own, never into the new transfer's, and leaves nothing behind.
        File unopened = dataFile("unopened.bin");
        start("uo", "download", "unopened.bin");
        boolean[] uoRestarted = {false};
        DenextTransferHttp.onOpen = () -> {
            boolean c = cancel("uo");
            boolean f = forget("uo");
            start("uo", "download", "unopened.bin");
            boolean[] paused = {false};
            DenextTransferHttp.onDownloaded = () -> paused[0] = pause("uo");
            work("uo");
            DenextTransferHttp.nextBody = DenextTransferHttp.STALE;
            uoRestarted[0] = c && f && paused[0];
        };
        result = work("uo");
        check("the id was restarted and paused before the old worker opened its file", uoRestarted[0],
            "not restarted");
        check("an unopened old worker leaves only the new transfer's partial file", parts(unopened).length == 1,
            String.join(", ", parts(unopened)));
        DenextTransferHttp.found = null;
        boolean uoResumed = resume("uo");
        result = work("uo");
        check("an unopened old worker does not write into the new transfer's partial file",
            uoResumed && java.util.Arrays.equals(DenextTransferHttp.found, DenextTransferHttp.BODY),
            DenextTransferHttp.found == null ? "nothing to resume from"
                : new String(DenextTransferHttp.found, StandardCharsets.UTF_8));
        check("the new transfer finishes", state("uo").equals("done") && unopened.isFile() && !partLeft(unopened),
            state("uo") + ", " + String.join(", ", parts(unopened)));

        // A start that lands between a cancel's state change and the rest of the cancel (here, from
        // the WorkManager cancel the plugin makes): the cancel's cleanup is done by then, so the
        // transfer started again under the id keeps its partial file.
        File recancelled = dataFile("recancelled.bin");
        start("rc", "download", "recancelled.bin");
        WorkManager manager = WorkManager.getInstance(context);
        boolean[] rcRestarted = {false};
        manager.onCancel = () -> {
            manager.onCancel = null;
            start("rc", "download", "recancelled.bin");
            boolean[] paused = {false};
            DenextTransferHttp.onDownloaded = () -> paused[0] = pause("rc");
            work("rc");
            rcRestarted[0] = paused[0];
        };
        boolean rcCancelled = cancel("rc");
        manager.onCancel = null;
        check("a start inside the cancel was paused with its bytes", rcCancelled && rcRestarted[0],
            rcCancelled + " / " + rcRestarted[0]);
        check("a cancel leaves the restarted transfer's partial file", partLeft(recancelled), "deleted");
        DenextTransferHttp.found = null;
        boolean rcResumed = resume("rc");
        result = work("rc");
        check("the restarted transfer resumes from its own bytes",
            rcResumed && java.util.Arrays.equals(DenextTransferHttp.found, DenextTransferHttp.BODY),
            DenextTransferHttp.found == null ? "nothing to resume from" : DenextTransferHttp.found.length + " bytes");

        // Records and work from before attempts (no token, the partial file <target>.denext-part):
        // a paused one resumes from its bytes, a running one's work finishes.
        File legacyPaused = dataFile("legacy-paused.bin");
        putLegacy("lp", "legacy-paused.bin", "paused");
        legacyPaused.getParentFile().mkdirs();
        Files.write(new File(legacyPaused.getPath() + ".denext-part").toPath(), DenextTransferHttp.BODY);
        DenextTransferHttp.found = null;
        boolean lpResumed = resume("lp");
        result = work("lp");
        check("a paused transfer from before attempts resumes from its partial file",
            lpResumed && java.util.Arrays.equals(DenextTransferHttp.found, DenextTransferHttp.BODY),
            lpResumed + " / " + (DenextTransferHttp.found == null ? "nothing" : DenextTransferHttp.found.length));
        check("a paused transfer from before attempts finishes", state("lp").equals("done")
            && legacyPaused.isFile() && !partLeft(legacyPaused), state("lp") + ", " + String.join(", ", parts(legacyPaused)));
        File legacyRunning = dataFile("legacy-running.bin");
        putLegacy("lr", "legacy-running.bin", "running");
        manager.enqueued.put("denext-transfer-lr", new OneTimeWorkRequest.Builder(DenextTransferWorker.class)
            .setInputData(new Data.Builder().putString(DenextTransferWorker.KEY_ID, "lr").build())
            .build());
        result = work("lr");
        check("work from before attempts finishes its transfer", state("lr").equals("done")
            && legacyRunning.isFile() && !partLeft(legacyRunning), state("lr") + " / " + result);

        // A start cleans up the partial files of dead attempts at its path (and one from before
        // attempts), but not a live transfer's, of another id, to the same path, nor other files.
        File shared = dataFile("shared.bin");
        start("sa", "download", "shared.bin");
        DenextTransferHttp.onDownloaded = () -> pause("sa");
        work("sa");
        String[] live = parts(shared);
        File dead = new File(shared.getPath() + ".deadbeef.denext-part");
        File deadMeta = new File(dead.getPath() + ".meta");
        File oldPart = new File(shared.getPath() + ".denext-part");
        File other = new File(shared.getPath() + ".notes.txt");
        for (File f : new File[] {dead, deadMeta, oldPart, other}) Files.write(f.toPath(), DenextTransferHttp.BODY);
        start("sb", "download", "shared.bin");
        check("a start deletes the dead attempts' partial files", !dead.exists() && !deadMeta.exists()
            && !oldPart.exists(), "left: " + String.join(", ", parts(shared)));
        check("a start keeps a live transfer's partial file at the same path", live.length == 1
            && new File(shared.getParentFile(), live[0]).isFile(), "live " + String.join(", ", live));
        check("a start keeps other files beside the target", other.isFile(), "deleted " + other.getName());

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
 * The HTTP half, scripted: a download notes what its partial file held ({@link #found}) and
 * writes {@link #BODY} to it, an upload sends nothing. The hooks run once each, at the point
 * their name says, then clear.
 */
final class DenextTransferHttp {
    static final byte[] BODY = "denext transfer body".getBytes(StandardCharsets.UTF_8);
    /** What a stale worker writes, told apart from {@link #BODY}. */
    static final byte[] STALE = "a stale worker's body".getBytes(StandardCharsets.UTF_8);

    /** The partial file's bytes when the last download began (null: there was none). */
    static byte[] found;
    /** Written by the next download in place of {@link #BODY}, once. */
    static byte[] nextBody;
    /** When a download begins, before it reads or opens its partial file. */
    static Runnable onOpen;

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

    private static void fireOpen() {
        Runnable hook = onOpen;
        onOpen = null;
        if (hook != null) hook.run();
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

    static File partFile(File target, String attempt) {
        if (attempt == null || attempt.isEmpty()) return new File(target.getPath() + ".denext-part");
        return new File(target.getPath() + "." + attempt.substring(0, Math.min(8, attempt.length())) + ".denext-part");
    }

    static File metaFile(File part) {
        if (onMoved != null && !part.exists()) fire(true, true);
        return new File(part.getPath() + ".meta");
    }

    static Result download(String url, Map<String, String> headers, File part, Listener listener)
        throws IOException {
        fireOpen();
        found = part.isFile() ? Files.readAllBytes(part.toPath()) : null;
        byte[] body = nextBody == null ? BODY : nextBody;
        nextBody = null;
        part.getParentFile().mkdirs();
        Files.write(part.toPath(), body);
        listener.progress(body.length, body.length);
        fire(true, false);
        if (listener.stopped()) throw new Stopped();
        return new Result(200, body.length, null, new HashMap<>());
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
