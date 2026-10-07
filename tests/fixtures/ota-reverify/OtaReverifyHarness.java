package dev.denext.ota;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.os.Bundle;
import com.getcapacitor.Bridge;
import com.getcapacitor.ProcessedRoute;
import com.getcapacitor.RouteProcessor;
import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Drives the generated DenextOtaStore through launches and served requests on the JDK, against
 * the stand-ins next to it. Every API added with re-verification is reached by reflection, so the
 * harness also compiles against an older template and reports what that one gets wrong. Prints
 * one "ok <name>" or "FAIL <name>" line per check.
 */
public final class OtaReverifyHarness {

    static final String[][] FILES = {
        { "index.html", "<!doctype html><script src=/app.js></script>" },
        { "app.js", "console.log('ui')" },
        { "assets/logo.svg", "<svg/>" },
    };

    static int failures = 0;

    static void check(String name, boolean ok) {
        System.out.println((ok ? "ok " : "FAIL ") + name);
        if (!ok) failures++;
    }

    /** An in-memory SharedPreferences. */
    static final class Prefs implements SharedPreferences {
        final Map<String, Object> values = new HashMap<>();

        public String getString(String key, String fallback) {
            Object value = values.get(key);
            return value instanceof String ? (String) value : fallback;
        }

        public int getInt(String key, int fallback) {
            Object value = values.get(key);
            return value instanceof Integer ? (Integer) value : fallback;
        }

        public long getLong(String key, long fallback) {
            Object value = values.get(key);
            return value instanceof Long ? (Long) value : fallback;
        }

        public boolean contains(String key) {
            return values.containsKey(key);
        }

        public Editor edit() {
            Map<String, Object> changes = new HashMap<>();
            List<String> removals = new ArrayList<>();
            return new Editor() {
                public Editor putString(String key, String value) {
                    changes.put(key, value);
                    return this;
                }

                public Editor putInt(String key, int value) {
                    changes.put(key, value);
                    return this;
                }

                public Editor putLong(String key, long value) {
                    changes.put(key, value);
                    return this;
                }

                public Editor remove(String key) {
                    removals.add(key);
                    return this;
                }

                public boolean commit() {
                    for (String key : removals) values.remove(key);
                    for (Map.Entry<String, Object> change : changes.entrySet()) {
                        if (change.getValue() == null) values.remove(change.getKey());
                        else values.put(change.getKey(), change.getValue());
                    }
                    return true;
                }

                public void apply() {
                    commit();
                }
            };
        }
    }

    /** A Context over a temp directory, with the OTA public key in its meta-data. */
    static final class App extends Context {
        final File dir;
        final Prefs prefs = new Prefs();
        final PackageManager packages = new PackageManager();

        App(File dir, String publicKey) {
            this.dir = dir;
            packages.applicationInfo.metaData = new Bundle();
            if (publicKey != null) packages.applicationInfo.metaData.putString("dev.denext.ota.PUBLIC_KEY", publicKey);
            packages.packageInfo.versionName = "1.0";
            packages.packageInfo.longVersionCode = 1;
        }

        public SharedPreferences getSharedPreferences(String name, int mode) {
            return prefs;
        }

        public File getNoBackupFilesDir() {
            return new File(dir, "no_backup");
        }

        public File getFilesDir() {
            return new File(dir, "files");
        }

        public PackageManager getPackageManager() {
            return packages;
        }

        public String getPackageName() {
            return "com.example.app";
        }

        public Context getApplicationContext() {
            return this;
        }

        public ApplicationInfo getApplicationInfo() {
            return packages.applicationInfo;
        }

        public AssetManager getAssets() {
            return new AssetManager(new File(dir, "assets"));
        }
    }

    static String sha256(byte[] data) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(data)) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    static List<DenextOtaStore.ManifestFile> manifestFiles() throws Exception {
        List<DenextOtaStore.ManifestFile> files = new ArrayList<>();
        for (String[] file : FILES) {
            byte[] bytes = file[1].getBytes(StandardCharsets.UTF_8);
            files.add(new DenextOtaStore.ManifestFile(file[0], sha256(bytes), bytes.length));
        }
        return files;
    }

    static String sign(KeyPair key, byte[] payload) throws Exception {
        Signature signer = Signature.getInstance("SHA256withECDSAinP1363Format");
        signer.initSign(key.getPrivate());
        signer.update(payload);
        return Base64.getEncoder().encodeToString(signer.sign());
    }

    /** The stored manifest as the plugin writes it: every field the signature covers. */
    static String storedManifest(String version, String notes, String signature) throws Exception {
        StringBuilder files = new StringBuilder();
        for (DenextOtaStore.ManifestFile file : manifestFiles()) {
            if (files.length() > 0) files.append(',');
            files.append("{\"path\":\"").append(file.path).append("\",\"sha256\":\"").append(file.sha256)
                .append("\",\"size\":").append(file.size).append('}');
        }
        return "{\"version\":\"" + version + "\",\"files\":[" + files + "],\"required\":false,\"notes\":\"" + notes +
            "\",\"sequence\":7" + (signature == null ? "" : ",\"signature\":\"" + signature + "\"") + "}";
    }

    /** Puts {@code version} in place the way a finished download leaves it. */
    static File install(App app, String version, String manifest) throws Exception {
        File dir = new File(new File(app.getNoBackupFilesDir(), "denext-ota"), version);
        for (String[] file : FILES) {
            File target = new File(dir, file[0]);
            target.getParentFile().mkdirs();
            Files.write(target.toPath(), file[1].getBytes(StandardCharsets.UTF_8));
        }
        File stored = new File(dir, "_denext/ota.json");
        stored.getParentFile().mkdirs();
        Files.write(stored.toPath(), manifest.getBytes(StandardCharsets.UTF_8));
        return dir;
    }

    /** A new process: a fresh store singleton over the same app data. */
    static DenextOtaStore launch(App app) throws Exception {
        Field shared = DenextOtaStore.class.getDeclaredField("shared");
        shared.setAccessible(true);
        shared.set(null, null);
        DenextOtaStore.launchIsTrial = false;
        return DenextOtaStore.get(app);
    }

    static Object call(Object target, String name, Object... args) {
        for (Method method : DenextOtaStore.class.getDeclaredMethods()) {
            if (method.getName().equals(name) && method.getParameterCount() == args.length) {
                try {
                    method.setAccessible(true);
                    return method.invoke(target, args);
                } catch (ReflectiveOperationException ex) {
                    throw new IllegalStateException(ex.getCause() == null ? ex : ex.getCause());
                }
            }
        }
        return null;
    }

    static boolean has(String name) {
        for (Method method : DenextOtaStore.class.getDeclaredMethods()) {
            if (method.getName().equals(name)) return true;
        }
        return false;
    }

    /** Events the store reports: "version serving". */
    static final List<String> events = new ArrayList<>();

    /** Attaches a bridge and a listener (store.attach), as the plugin does when it loads. */
    static Bridge attach(DenextOtaStore store) throws Exception {
        Bridge bridge = new Bridge();
        if (!has("attach")) return bridge;
        Class<?> type = Class.forName("dev.denext.ota.DenextOtaStore$TamperListener");
        Object listener = Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type }, (proxy, method, args) -> {
            if (method.getName().equals("onTampered")) events.add(args[0] + " " + args[2]);
            return null;
        });
        call(store, "attach", bridge, listener);
        return bridge;
    }

    /** What the local server would read for {@code path}: null when the processor is missing. */
    static ProcessedRoute serve(DenextOtaStore store, String basePath, String path) {
        RouteProcessor routes = (RouteProcessor) call(store, "routes");
        return routes == null ? null : routes.process(basePath, path);
    }

    static boolean served(DenextOtaStore store, File dir, String path) {
        ProcessedRoute route = serve(store, "", path);
        return route != null && !route.isAsset() && route.getPath().equals(dir.getAbsolutePath() + path);
    }

    static boolean refused(DenextOtaStore store, File dir, String path) {
        ProcessedRoute route = serve(store, "", path);
        return route != null && !route.isAsset() && route.getPath().equals(dir.getAbsolutePath());
    }

    public static void main(String[] args) throws Exception {
        File work = new File(args[0]);
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        KeyPair key = generator.generateKeyPair();
        KeyPair other = generator.generateKeyPair();
        String publicKey = Base64.getEncoder().encodeToString(key.getPublic().getEncoded());
        String version = DenextOtaStore.manifestVersion(manifestFiles());
        byte[] payload = DenextOtaStore.signaturePayload(version, false, "hello", 7L, null, null);
        String signature = sign(key, payload);

        // ---- the round trip: what the plugin stores verifies again -------------------------------
        {
            Constructor<?> full = null;
            for (Constructor<?> c : DenextOtaStore.ApplyRequest.class.getDeclaredConstructors()) {
                if (c.getParameterCount() == 10) full = c;
            }
            boolean ok = false;
            if (full != null) {
                Object request = full.newInstance("http://127.0.0.1/ui", new HashMap<String, String>(), version, manifestFiles(), 7L, false, "hello", null, null, signature);
                File dir = new File(work, "roundtrip");
                Method write = DenextOtaStore.class.getDeclaredMethod("writeManifest", DenextOtaStore.ApplyRequest.class, File.class);
                write.setAccessible(true);
                write.invoke(null, request, dir);
                try {
                    ok = call(null, "verifyInstalled", dir, version, publicKey) != null;
                } catch (IllegalStateException ex) {
                    System.err.println(ex.getCause());
                }
            }
            check("the stored manifest keeps the signed fields and verifies again", ok);
        }

        // ---- a clean install is served, file by file ---------------------------------------------
        App app = new App(new File(work, "clean"), publicKey);
        launch(app).startDirectory(); // the first launch of this binary: records it, serves the bundle
        File dir = install(app, version, storedManifest(version, "hello", signature));
        app.prefs.values.put("current", version);
        DenextOtaStore store = launch(app);
        File start = store.startDirectory();
        check("launch serves a downloaded UI whose stored manifest verifies", dir.equals(start));
        Bridge bridge = attach(store);
        bridge.served = dir.getAbsolutePath();
        check("an untampered file is served", served(store, dir, "/app.js"));
        check("an untampered nested file is served", served(store, dir, "/assets/logo.svg"));
        ProcessedRoute index = serve(store, dir.getAbsolutePath(), "/index.html");
        check("the page itself is served (index.html)", index != null && index.getPath().equals(dir.getAbsolutePath() + "/index.html"));
        check("the stored manifest is served (pageUiVersion)", served(store, dir, "/_denext/ota.json"));
        check("a missing unlisted file is refused without quarantining", refused(store, dir, "/nope.js") && app.prefs.getString("tampered", null) == null);
        check("a path that climbs out is refused without quarantining", refused(store, dir, "/../secret") && app.prefs.getString("tampered", null) == null);
        ProcessedRoute file = serve(store, "", "/_capacitor_file_/data/x.png");
        check("Capacitor's file paths pass through", file != null && file.getPath().equals("/_capacitor_file_/data/x.png"));
        bridge.served = "public";
        ProcessedRoute asset = serve(store, "", "/app.js");
        ProcessedRoute assetIndex = serve(store, "public", "/index.html");
        check(
            "the bundled assets are answered as Capacitor does",
            asset != null && asset.isAsset() && asset.getPath().equals("/app.js") &&
                assetIndex != null && assetIndex.isAsset() && assetIndex.getPath().equals("public/index.html")
        );

        // ---- one file changed after the download: refused on the next launch ---------------------
        Files.write(new File(dir, "app.js").toPath(), "steal(document.cookie)".getBytes(StandardCharsets.UTF_8));
        events.clear();
        store = launch(app);
        check("a launch over a changed file still starts (the manifest verifies)", dir.equals(store.startDirectory()));
        bridge = attach(store);
        bridge.served = dir.getAbsolutePath();
        check("the unchanged page is served", served(store, dir, "/index.html"));
        check("the changed file is refused", refused(store, dir, "/app.js"));
        check("the version is recorded as tampered", version.equals(call(store, "tampered")));
        check("it is no longer current", app.prefs.getString("current", null) == null);
        check("its directory moved to quarantine/", !dir.exists() && new File(dir.getParentFile(), "quarantine/" + version + "/app.js").isFile());
        check("the plugin is told while it is being served", events.equals(List.of(version + " true")));
        check("nothing else of it is served afterwards", refused(store, dir, "/index.html"));
        check("the next launch serves the bundled UI", launch(app).startDirectory() == null);

        // ---- the stored manifest changed: refused at launch, before any page ---------------------
        app = new App(new File(work, "manifest"), publicKey);
        launch(app).startDirectory();
        dir = install(app, version, storedManifest(version, "hello (edited)", signature));
        app.prefs.values.put("current", version);
        events.clear();
        store = launch(app);
        check("a stored manifest whose signature no longer verifies is refused at launch", store.startDirectory() == null);
        check("it is recorded as tampered and quarantined", version.equals(call(store, "tampered")) && !dir.exists());
        attach(store);
        check("the plugin hears it once it loads", events.equals(List.of(version + " false")));

        // ---- signed by another key -----------------------------------------------------------------
        app = new App(new File(work, "other-key"), publicKey);
        launch(app).startDirectory();
        install(app, version, storedManifest(version, "hello", sign(other, payload)));
        app.prefs.values.put("current", version);
        check("a manifest signed by another key is refused at launch", launch(app).startDirectory() == null);

        // ---- a file planted next to the UI -------------------------------------------------------
        app = new App(new File(work, "planted"), publicKey);
        launch(app).startDirectory();
        dir = install(app, version, storedManifest(version, "hello", signature));
        Files.write(new File(dir, "evil.js").toPath(), "evil()".getBytes(StandardCharsets.UTF_8));
        app.prefs.values.put("current", version);
        store = launch(app);
        store.startDirectory();
        bridge = attach(store);
        bridge.served = dir.getAbsolutePath();
        check("a file the manifest does not list is refused and quarantines the UI", refused(store, dir, "/evil.js") && version.equals(call(store, "tampered")));

        // ---- a trial launch over a changed manifest ------------------------------------------------
        app = new App(new File(work, "trial"), publicKey);
        launch(app).startDirectory();
        install(app, version, storedManifest(version, "x", signature));
        app.prefs.values.put("pending", version);
        app.prefs.values.put("trialAttempts", 1);
        store = launch(app);
        check("a pending UI that fails re-verification is not tried", store.startDirectory() == null && !DenextOtaStore.launchIsTrial);
        check("its trial is cleared", app.prefs.getString("pending", null) == null);

        // ---- unsigned (no key embedded): the files are still checked -------------------------------
        app = new App(new File(work, "unsigned"), null);
        launch(app).startDirectory();
        dir = install(app, version, storedManifest(version, "hello", null));
        app.prefs.values.put("current", version);
        store = launch(app);
        check("without a key, a UI whose manifest matches its version is served", dir.equals(store.startDirectory()));
        bridge = attach(store);
        bridge.served = dir.getAbsolutePath();
        Files.write(new File(dir, "assets/logo.svg").toPath(), "<svg onload=evil()/>".getBytes(StandardCharsets.UTF_8));
        check("without a key, a changed file is still refused", refused(store, dir, "/assets/logo.svg"));

        // ---- downloading the same version again lifts the quarantine -----------------------------
        dir = install(app, version, storedManifest(version, "hello", null));
        store.stage(version, 7L);
        check("a fresh download of a quarantined version is served again", served(store, dir, "/assets/logo.svg"));

        System.out.println("done " + failures);
    }
}
