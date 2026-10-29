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

    static boolean hasArity(String name, int arity) {
        for (Method method : DenextOtaStore.class.getDeclaredMethods()) {
            if (method.getName().equals(name) && method.getParameterCount() == arity) return true;
        }
        return false;
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

    /** What the local server reads for a {@code /_capacitor_file_} request of {@code file}. */
    static String capacitorFile(DenextOtaStore store, String file) {
        ProcessedRoute route = serve(store, "", Bridge.CAPACITOR_FILE_START + file);
        return route == null ? null : route.getPath();
    }

    /** Whether a {@code /_capacitor_file_} request of {@code file} reads that file. */
    static boolean fileServed(DenextOtaStore store, String file) {
        return (Bridge.CAPACITOR_FILE_START + file).equals(capacitorFile(store, file));
    }

    /**
     * The platform check's refusal code for a manifest with that stamp and field, or null, in an app
     * that embeds a public key ({@code signed}) or not.
     */
    static String platformRefusal(String stamp, Object platform, boolean signed) throws Exception {
        List<DenextOtaStore.ManifestFile> files = manifestFiles();
        if (stamp != null) {
            byte[] bytes = stamp.getBytes(StandardCharsets.UTF_8);
            files.add(new DenextOtaStore.ManifestFile("_denext/platform.txt", sha256(bytes), bytes.length));
        }
        if (!has("checkPlatform")) return "missing";
        try {
            if (call(null, "checkPlatform", platform, files, signed) == null && !hasArity("checkPlatform", 3)) {
                return "missing";
            }
            return null;
        } catch (IllegalStateException ex) {
            return ex.getCause() instanceof DenextOtaStore.OtaException ? ((DenextOtaStore.OtaException) ex.getCause()).code : ex.toString();
        }
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
                if (c.getParameterCount() == 11) full = c;
            }
            boolean ok = false;
            if (full != null) {
                Object request = full.newInstance("http://127.0.0.1/ui", new HashMap<String, String>(), version, manifestFiles(), 7L, false, "hello", null, null, signature, null);
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

        // ---- the v4 payload: a signed expiresAt is stored and verified again ---------------------
        {
            Long expiresAt = System.currentTimeMillis() / 1000 + 86_400;
            String v4 = sign(key, DenextOtaStore.signaturePayload(version, false, "hello", 7L, null, null, expiresAt));
            Constructor<?> full = null;
            for (Constructor<?> c : DenextOtaStore.ApplyRequest.class.getDeclaredConstructors()) {
                if (c.getParameterCount() == 11) full = c;
            }
            boolean ok = false;
            boolean alteredRefused = false;
            if (full != null) {
                Object request = full.newInstance("http://127.0.0.1/ui", new HashMap<String, String>(), version, manifestFiles(), 7L, false, "hello", null, null, v4, expiresAt);
                File dir = new File(work, "roundtrip-v4");
                Method write = DenextOtaStore.class.getDeclaredMethod("writeManifest", DenextOtaStore.ApplyRequest.class, File.class);
                write.setAccessible(true);
                write.invoke(null, request, dir);
                try {
                    ok = call(null, "verifyInstalled", dir, version, publicKey) != null;
                } catch (IllegalStateException ex) {
                    System.err.println(ex.getCause());
                }
                File stored = new File(dir, "_denext/ota.json");
                String text = new String(Files.readAllBytes(stored.toPath()), StandardCharsets.UTF_8);
                Files.write(stored.toPath(), text.replace(String.valueOf(expiresAt), String.valueOf(expiresAt + 1)).getBytes(StandardCharsets.UTF_8));
                try {
                    call(null, "verifyInstalled", dir, version, publicKey);
                } catch (IllegalStateException ex) {
                    alteredRefused = true;
                }
            }
            check("expiry: the stored v4 manifest keeps expiresAt and verifies at launch", ok);
            check("expiry: a stored expiresAt changed on the device fails the signature", alteredRefused);
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
        File root = dir.getParentFile();
        check("capacitor file: a file outside the versions root passes through", fileServed(store, "/tmp/photo.jpg"));
        check("capacitor file: an untampered file of a downloaded UI is served", fileServed(store, dir.getAbsolutePath() + "/app.js"));
        Files.write(new File(root, "stray.txt").toPath(), "x".getBytes(StandardCharsets.UTF_8));
        check(
            "capacitor file: a file outside a version directory is refused",
            !fileServed(store, root.getAbsolutePath() + "/stray.txt") && call(store, "tampered") == null
        );
        check(
            "capacitor file: a path that climbs into the versions root is checked",
            !fileServed(store, dir.getAbsolutePath() + "/../" + version + "/nope.js") && call(store, "tampered") == null
        );
        File link = new File(root.getParentFile(), "ota-link");
        Files.createSymbolicLink(link.toPath(), root.getAbsoluteFile().toPath());
        check(
            "capacitor file: a symlinked spelling of the versions root is checked",
            !fileServed(store, link.getAbsolutePath() + "/stray.txt") && fileServed(store, link.getAbsolutePath() + "/" + version + "/app.js")
        );
        // No file Capacitor names has a control character; a NUL cuts a path short in native code.
        check("capacitor file: a NUL that cuts the path short is refused", !fileServed(store, "/tmp/photo.jpg\0.png"));
        check("capacitor file: a control character is refused", !fileServed(store, "/tmp/photo\u0001.jpg"));
        check(
            "capacitor file: a NUL is refused inside the versions root too",
            !fileServed(store, dir.getAbsolutePath() + "/app.js\0") && call(store, "tampered") == null
        );
        String refusedFile = capacitorFile(store, root.getAbsolutePath() + "/stray.txt");
        check("capacitor file: a refused file reads a directory (the request fails)", refusedFile != null && new File(refusedFile.replace(Bridge.CAPACITOR_FILE_START, "")).isDirectory());
        bridge.served = "/elsewhere";
        check("fail closed: a served directory outside the versions root is refused", "/elsewhere".equals(serve(store, "", "/app.js").getPath()));
        bridge.served = root.getAbsolutePath();
        check("fail closed: the versions root itself is refused as a base", root.getAbsolutePath().equals(serve(store, "", "/app.js").getPath()));
        bridge.served = "public";
        check("capacitor file: checked while the bundled assets are served too", !fileServed(store, root.getAbsolutePath() + "/stray.txt"));
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

        // ---- a changed file read through /_capacitor_file_ -----------------------------------------
        app = new App(new File(work, "capacitor-file"), publicKey);
        launch(app).startDirectory();
        dir = install(app, version, storedManifest(version, "hello", signature));
        Files.write(new File(dir, "app.js").toPath(), "steal(document.cookie)".getBytes(StandardCharsets.UTF_8));
        app.prefs.values.put("current", version);
        events.clear();
        store = launch(app);
        store.startDirectory();
        bridge = attach(store);
        bridge.served = dir.getAbsolutePath();
        check(
            "capacitor file: a changed file is refused and quarantines the UI",
            !fileServed(store, Bridge.CAPACITOR_FILE_START + dir.getAbsolutePath() + "/app.js") && version.equals(call(store, "tampered"))
        );
        check("capacitor file: the plugin is told while the version is being served", events.equals(List.of(version + " true")));

        // ---- a verified file rewritten while the process runs ---------------------------------------
        // The same size and modification time: only the change time (and the bytes) tell it apart.
        app = new App(new File(work, "rewritten"), publicKey);
        launch(app).startDirectory();
        dir = install(app, version, storedManifest(version, "hello", signature));
        app.prefs.values.put("current", version);
        store = launch(app);
        store.startDirectory();
        bridge = attach(store);
        bridge.served = dir.getAbsolutePath();
        check("rewrite: a verified file is served", served(store, dir, "/app.js"));
        File rewritten = new File(dir, "app.js");
        long modified = rewritten.lastModified();
        // Android's stat reports the change time in whole seconds: rewrite in a later second.
        Thread.sleep(1_100);
        Files.write(rewritten.toPath(), "console.log('xx')".getBytes(StandardCharsets.UTF_8));
        rewritten.setLastModified(modified);
        check(
            "rewrite: a verified file rewritten in place is refused and quarantines the UI",
            refused(store, dir, "/app.js") && version.equals(call(store, "tampered"))
        );

        // ---- the platform stamp, checked natively too ----------------------------------------------
        check("platform: an Android export is accepted", platformRefusal("android", "android", false) == null);
        check("platform: an Android stamp without the field is accepted", platformRefusal("android", null, false) == null);
        check("platform: an iOS export is refused (platform_mismatch)", "platform_mismatch".equals(platformRefusal("ios", "ios", false)));
        check("platform: an iOS stamp without the field is refused", "platform_mismatch".equals(platformRefusal("ios", null, false)));
        check("platform: the field without a matching stamp is refused", "platform_mismatch".equals(platformRefusal(null, "android", false)));
        check("platform: a field that disagrees with the stamp is refused", "platform_mismatch".equals(platformRefusal("ios", "android", false)));
        check("platform: a field that is not a string is invalid", "invalid".equals(platformRefusal("android", 1, false)));
        // An app that embeds a public key takes only its own platform's stamped export: a web export
        // signed with the same key is not an Android UI. Unsigned (pinned-origin) apps take it as before.
        check("platform: a signed app refuses an unstamped export (platform_mismatch)", "platform_mismatch".equals(platformRefusal(null, null, true)));
        check("platform: a signed app takes its own platform's export", platformRefusal("android", "android", true) == null);
        check("platform: a signed app refuses another platform's export", "platform_mismatch".equals(platformRefusal("ios", "ios", true)));
        check("platform: an unsigned app takes an unstamped export", platformRefusal(null, null, false) == null);

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

        // ---- a file that cannot be read right now ---------------------------------------------------
        // An I/O or permission error (or storage that is not available yet) is not a change to the
        // UI: refuse the read, keep the version, and check it again later.
        app = new App(new File(work, "locked"), publicKey);
        launch(app).startDirectory();
        dir = install(app, version, storedManifest(version, "hello", signature));
        app.prefs.values.put("current", version);
        events.clear();
        store = launch(app);
        check("unreadable: the UI is served while its files can be read", dir.equals(store.startDirectory()));
        bridge = attach(store);
        bridge.served = dir.getAbsolutePath();
        File lockedFile = new File(dir, "app.js");
        boolean canLock = lockedFile.setReadable(false, false) && !lockedFile.canRead();
        if (!canLock) {
            // Running as root: permissions do not stop a read, so there is nothing to observe.
            lockedFile.setReadable(true, false);
            System.out.println("skip unreadable files (root ignores permissions)");
        } else {
            check("a file that cannot be read is refused", refused(store, dir, "/app.js"));
            check(
                "a file that cannot be read does not quarantine the UI",
                call(store, "tampered") == null && version.equals(app.prefs.getString("current", null)) && lockedFile.exists() && events.isEmpty()
            );
            lockedFile.setReadable(true, false);
            check("once it can be read it is checked again and served", served(store, dir, "/app.js"));
            File lockedManifest = new File(dir, "_denext/ota.json");
            lockedManifest.setReadable(false, false);
            check("the stored manifest that cannot be read is refused to the page", refused(store, dir, "/_denext/ota.json") && call(store, "tampered") == null);
            store = launch(app);
            check("a launch whose stored manifest cannot be read serves the bundled UI", store.startDirectory() == null);
            check(
                "a stored manifest that cannot be read does not quarantine the UI",
                call(store, "tampered") == null && version.equals(app.prefs.getString("current", null)) && lockedManifest.exists()
            );
            app.prefs.values.put("pending", version);
            app.prefs.values.put("trialAttempts", 1);
            store = launch(app);
            check(
                "a pending UI that cannot be read is not tried this launch and keeps its trial",
                store.startDirectory() == null && !DenextOtaStore.launchIsTrial &&
                    version.equals(app.prefs.getString("pending", null)) && app.prefs.getInt("trialAttempts", 0) == 1
            );
            lockedManifest.setReadable(true, false);
            store = launch(app);
            check("the next launch that can read it tries it", dir.equals(store.startDirectory()) && DenextOtaStore.launchIsTrial);
        }

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
