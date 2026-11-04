// Drives the generated DenextOtaStore through launches and served requests on macOS (each launch
// a new store over the same directory and defaults). Prints "ok <name>" / "FAIL <name>" per check.
import Capacitor
import CryptoKit
import Foundation

let work = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
// The harness's requests come from 127.0.0.1, which only a debug build accepts unsigned.
DenextOtaStore.isDebugBuild = true
let fm = FileManager.default
var failures = 0

func check(_ name: String, _ ok: Bool) {
    print("\(ok ? "ok" : "FAIL") \(name)")
    if !ok { failures += 1 }
}

let files: [(String, String)] = [
    ("index.html", "<!doctype html><script src=/app.js></script>"),
    ("app.js", "console.log('ui')"),
    ("assets/logo.svg", "<svg/>"),
]
let manifestFiles = files.map {
    DenextOtaStore.ManifestFile(path: $0.0, sha256: DenextOtaStore.sha256Hex(Data($0.1.utf8)), size: Int64($0.1.utf8.count))
}
let version = DenextOtaStore.manifestVersion(manifestFiles)
let key = P256.Signing.PrivateKey()
let otherKey = P256.Signing.PrivateKey()
let payload = DenextOtaStore.signaturePayload(version: version, required: false, notes: "hello", sequence: 7, minNative: nil, nativeFingerprint: nil)

func sign(_ signer: P256.Signing.PrivateKey) -> String {
    (try! signer.signature(for: payload)).rawRepresentation.base64EncodedString()
}

/// The stored manifest exactly as the plugin writes it: through ApplyRequest and storedManifest.
func storedManifest(notes: String = "hello", signature: String?) throws -> Data {
    var manifest: JSObject = [
        "version": version,
        "files": manifestFiles.map { ["path": $0.path, "sha256": $0.sha256, "size": Int($0.size)] as JSObject } as JSArray,
        "notes": "hello",
        "sequence": 7,
    ]
    if let signature { manifest["signature"] = signature }
    let request = try DenextOtaStore.ApplyRequest(baseUrl: "http://127.0.0.1/ui", headers: nil, manifest: manifest)
    let data = try DenextOtaStore.storedManifest(request)
    guard notes != "hello" else { return data }
    var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    object["notes"] = notes
    return try JSONSerialization.data(withJSONObject: object)
}

/// A device: the versions root and its own defaults.
struct Device {
    let root: URL
    let suite: String
    var defaults: UserDefaults { UserDefaults(suiteName: suite)! }
    var dir: URL { root.appendingPathComponent(version, isDirectory: true) }
    /// The app's bundled `public/` (only its path matters: the store never checks its files).
    let bundled: URL

    init(_ name: String) {
        root = work.appendingPathComponent(name).appendingPathComponent("denext-ota", isDirectory: true)
        suite = "dev.denext.ota-reverify.\(name).\(UUID().uuidString)"
        bundled = work.appendingPathComponent(name).appendingPathComponent("App.app/public", isDirectory: true)
    }

    /// A new process.
    func launch(key: DenextOtaStore.PublicKeyConfig) -> DenextOtaStore {
        DenextOtaStore(root: root, defaults: defaults, publicKey: key, bundled: bundled)
    }

    /// What the asset handler asks for a `/_capacitor_file_` request of `path` (a file path).
    func capacitorFile(_ store: DenextOtaStore, _ path: String) -> Bool {
        store.admitCapacitorFile("/_capacitor_file_" + path)
    }

    /// Puts the version in place the way a finished download leaves it.
    func install(_ manifest: Data) throws {
        try? fm.removeItem(at: dir)
        for (path, text) in files {
            let url = dir.appendingPathComponent(path)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url)
        }
        let url = dir.appendingPathComponent(DenextOtaStore.manifestPath)
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try manifest.write(to: url)
    }

    func admit(_ store: DenextOtaStore, _ path: String) -> Bool {
        store.admit(dir.path + path, servedFrom: dir.path)
    }

    func tamper(_ path: String, _ text: String) throws {
        try Data(text.utf8).write(to: dir.appendingPathComponent(path))
    }
}

func drain() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }

let signed = DenextOtaStore.PublicKeyConfig.key(key.publicKey)
var devices: [Device] = []
func device(_ name: String, current: Bool = true, manifest: Data) throws -> Device {
    let d = Device(name)
    devices.append(d)
    _ = d.launch(key: signed).prepareLaunch() // the first launch of this binary: the bundled UI
    try d.install(manifest)
    if current { d.defaults.set(version, forKey: "denext.ota.current") }
    return d
}

do {
    // ---- a clean install ------------------------------------------------------------------
    let clean = try device("clean", manifest: storedManifest(signature: sign(key)))
    var store = clean.launch(key: signed)
    check("launch serves a downloaded UI whose stored manifest verifies", store.prepareLaunch().directory?.path == clean.dir.path)
    check("an untampered file is served", clean.admit(store, "/app.js"))
    check("an untampered nested file is served", clean.admit(store, "/assets/logo.svg"))
    check("the stored manifest is served (pageUiVersion)", clean.admit(store, "/_denext/ota.json"))
    check("a missing unlisted file is refused without quarantining", !clean.admit(store, "/nope.js") && store.tampered == nil)
    check("a path that climbs out is refused without quarantining", !clean.admit(store, "/../secret") && store.tampered == nil)
    check("the bundled UI is not checked", store.admit(clean.bundled.path + "/app.js", servedFrom: clean.bundled.path))
    // Fail closed: native code only ever serves the bundled UI or a version directory.
    check("fail closed: a base outside the versions root and the bundled UI is refused", !store.admit("/elsewhere/app.js", servedFrom: "/elsewhere"))
    check("fail closed: the versions root itself is refused as a base", !store.admit(clean.root.path + "/app.js", servedFrom: clean.root.path))
    check("fail closed: a bundled-UI route outside its directory is refused", !store.admit("/etc/passwd", servedFrom: clean.bundled.path))
    // Capacitor's /_capacitor_file_ paths skip the router: the asset handler asks the store.
    let photo = work.appendingPathComponent("photo.jpg")
    try Data("jpg".utf8).write(to: photo)
    check("capacitor file: a file outside the versions root passes through", clean.capacitorFile(store, photo.path))
    // Capacitor's read of a file that is not there fails anyway; refused here, nothing can appear
    // between the check and that read.
    check("capacitor file: a missing file is refused", !clean.capacitorFile(store, work.appendingPathComponent("nope.jpg").path))
    check("capacitor file: an untampered file of a downloaded UI is served", clean.capacitorFile(store, clean.dir.path + "/app.js"))
    try Data("x".utf8).write(to: clean.root.appendingPathComponent("stray.txt"))
    check("capacitor file: a file outside a version directory is refused", !clean.capacitorFile(store, clean.root.path + "/stray.txt") && store.tampered == nil)
    check(
        "capacitor file: a path that climbs into the versions root is checked",
        !clean.capacitorFile(store, clean.dir.path + "/../" + version + "/nope.js") && store.tampered == nil
    )
    let link = clean.root.deletingLastPathComponent().appendingPathComponent("ota-link")
    try fm.createSymbolicLink(at: link, withDestinationURL: clean.root)
    check(
        "capacitor file: a symlinked spelling of the versions root is checked",
        !clean.capacitorFile(store, link.path + "/stray.txt") && clean.capacitorFile(store, link.path + "/" + version + "/app.js")
    )
    check("capacitor file: the bridge's router paths are not checked here", store.admitCapacitorFile("/app.js"))
    // A NUL empties the path Capacitor's handler reads (`Data(contentsOf:)` of an empty URL raises
    // NSInvalidArgumentException, which crashes the app) or cuts it short; no file Capacitor names
    // has a control character. Refused wherever the path points.
    check("capacitor file: a NUL that empties the path is refused", !store.admitCapacitorFile("/_capacitor_file_/x\u{0}/.."))
    check("capacitor file: a NUL that cuts the path short is refused", !clean.capacitorFile(store, "/tmp/photo.jpg\u{0}.png"))
    check("capacitor file: a control character is refused", !clean.capacitorFile(store, "/tmp/photo\u{1}.jpg"))
    check(
        "capacitor file: a NUL is refused inside the versions root too",
        !clean.capacitorFile(store, clean.dir.path + "/app.js\u{0}") && store.tampered == nil
    )

    // ---- one file changed after the download -----------------------------------------------
    try clean.tamper("app.js", "steal(document.cookie)")
    store = clean.launch(key: signed)
    var heard: [String] = []
    store.setTamperHandler { version, _, serving in heard.append("\(version) \(serving)") }
    check("a launch over a changed file still starts (the manifest verifies)", store.prepareLaunch().directory != nil)
    check("the unchanged page is served", clean.admit(store, "/index.html"))
    check("the changed file is refused", !clean.admit(store, "/app.js"))
    drain()
    check("the version is recorded as tampered", store.tampered == version)
    check("it is no longer current", store.current == nil)
    check("its directory moved to quarantine/", !fm.fileExists(atPath: clean.dir.path) &&
        fm.fileExists(atPath: clean.root.appendingPathComponent("quarantine/\(version)/app.js").path))
    check("the plugin is told while it is being served", heard == ["\(version) true"])
    check("nothing else of it is served afterwards", !clean.admit(store, "/index.html"))
    check("the fallback is the bundled UI", store.fallbackDirectory() == nil)
    check("the next launch serves the bundled UI", clean.launch(key: signed).prepareLaunch().directory == nil)

    // ---- a changed file read through /_capacitor_file_ ---------------------------------------
    let viaFile = try device("capacitor-file", manifest: storedManifest(signature: sign(key)))
    try viaFile.tamper("app.js", "steal(document.cookie)")
    store = viaFile.launch(key: signed)
    heard = []
    store.setTamperHandler { version, _, serving in heard.append("\(version) \(serving)") }
    _ = store.prepareLaunch()
    check(
        "capacitor file: a changed file is refused and quarantines the UI",
        !viaFile.capacitorFile(store, "/_capacitor_file_" + viaFile.dir.path + "/app.js") &&
            store.tampered == version
    )
    drain()
    check("capacitor file: the plugin is told while the version is being served", heard == ["\(version) true"])

    // ---- another case of a UI file's path ---------------------------------------------------
    // On a case-insensitive volume (APFS's default) `APP.JS` opens `app.js`; any page script can
    // ask for one, so it is refused and never quarantines. On a case-sensitive volume a hard link
    // stands in for that second spelling of the same file.
    let cased = try device("case", manifest: storedManifest(signature: sign(key)))
    for (file, variant) in [("app.js", "APP.JS"), ("assets/logo.svg", "Assets/Logo.svg"), (DenextOtaStore.manifestPath, "_DENEXT/OTA.JSON")]
    where !fm.fileExists(atPath: cased.dir.appendingPathComponent(variant).path) {
        let to = cased.dir.appendingPathComponent(variant)
        try fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.linkItem(at: cased.dir.appendingPathComponent(file), to: to)
    }
    store = cased.launch(key: signed)
    heard = []
    store.setTamperHandler { version, _, serving in heard.append("\(version) \(serving)") }
    _ = store.prepareLaunch()
    check(
        "case: another case of a UI file is refused without quarantining",
        !cased.admit(store, "/APP.JS") && !cased.admit(store, "/Assets/Logo.svg") && store.tampered == nil
    )
    check(
        "case: another case of the stored manifest is refused without quarantining",
        !cased.admit(store, "/_DENEXT/OTA.JSON") && store.tampered == nil
    )
    check(
        "capacitor file: another case of a UI file is refused without quarantining",
        !cased.capacitorFile(store, cased.dir.path + "/APP.JS") &&
            !cased.capacitorFile(store, cased.root.path + "/" + version.uppercased() + "/app.js") && store.tampered == nil
    )
    drain()
    check(
        "case: the UI is still served after it",
        cased.admit(store, "/app.js") && cased.capacitorFile(store, cased.dir.path + "/app.js") &&
            store.current == version && heard.isEmpty
    )
    // A file of the UI under a name that is not another case of its own (a hard link) was added.
    try fm.linkItem(at: cased.dir.appendingPathComponent("app.js"), to: cased.dir.appendingPathComponent("copy.js"))
    check(
        "case: a UI file under another name still quarantines the UI",
        !cased.admit(store, "/copy.js") && store.tampered == version
    )
    drain()

    // ---- a verified file rewritten while the process runs ------------------------------------
    // The same size and modification date: only the change time (and the bytes) tell it apart.
    let rewritten = try device("rewritten", manifest: storedManifest(signature: sign(key)))
    store = rewritten.launch(key: signed)
    _ = store.prepareLaunch()
    check("rewrite: a verified file is served", rewritten.admit(store, "/app.js"))
    let rewrittenFile = rewritten.dir.appendingPathComponent("app.js").path
    let modified = try fm.attributesOfItem(atPath: rewrittenFile)[.modificationDate] as! Date
    try rewritten.tamper("app.js", "console.log('xx')")
    try fm.setAttributes([.modificationDate: modified], ofItemAtPath: rewrittenFile)
    check(
        "rewrite: a verified file rewritten in place is refused and quarantines the UI",
        !rewritten.admit(store, "/app.js") && store.tampered == version
    )

    // ---- the stored manifest changed ---------------------------------------------------------
    let edited = try device("manifest", manifest: storedManifest(notes: "hello (edited)", signature: sign(key)))
    store = edited.launch(key: signed)
    check("a stored manifest whose signature no longer verifies is refused at launch", store.prepareLaunch().directory == nil)
    check("it is recorded as tampered and quarantined", store.tampered == version && !fm.fileExists(atPath: edited.dir.path))
    heard = []
    store.setTamperHandler { version, _, serving in heard.append("\(version) \(serving)") }
    check("the plugin hears it once it loads", heard == ["\(version) false"])

    // ---- signed by another key; a key that does not parse --------------------------------------
    let other = try device("other-key", manifest: storedManifest(signature: sign(otherKey)))
    check("a manifest signed by another key is refused at launch", other.launch(key: signed).prepareLaunch().directory == nil)
    let invalid = try device("invalid-key", manifest: storedManifest(signature: sign(key)))
    check("an embedded key that does not parse refuses it (fail closed)", invalid.launch(key: .invalid).prepareLaunch().directory == nil)

    // ---- a file planted next to the UI ------------------------------------------------------
    let planted = try device("planted", manifest: storedManifest(signature: sign(key)))
    try planted.tamper("evil.js", "evil()")
    store = planted.launch(key: signed)
    _ = store.prepareLaunch()
    check("a file the manifest does not list is refused and quarantines the UI", !planted.admit(store, "/evil.js") && store.tampered == version)

    // ---- a trial launch over a changed manifest ----------------------------------------------
    let trial = try device("trial", current: false, manifest: storedManifest(notes: "x", signature: sign(key)))
    trial.defaults.set(version, forKey: "denext.ota.pending")
    trial.defaults.set(1, forKey: "denext.ota.trialAttempts")
    store = trial.launch(key: signed)
    let launch = store.prepareLaunch()
    check("a pending UI that fails re-verification is not tried", launch.directory == nil && !launch.trial)
    check("its trial is cleared", store.pending == nil)

    // ---- a file that cannot be read right now -------------------------------------------------
    // A launch before the first unlock (a silent push, a BGTask) finds the files there but
    // unreadable (data protection); a permission or I/O error looks the same. That is not a
    // change to the UI: refuse the read, keep the version, and check it again later.
    let locked = try device("locked", manifest: storedManifest(signature: sign(key)))
    store = locked.launch(key: signed)
    heard = []
    store.setTamperHandler { version, _, serving in heard.append("\(version) \(serving)") }
    check("unreadable: the UI is served while its files can be read", store.prepareLaunch().directory?.path == locked.dir.path)
    let lockedFile = locked.dir.appendingPathComponent("app.js").path
    try fm.setAttributes([.posixPermissions: 0], ofItemAtPath: lockedFile)
    check("a file that cannot be read is refused", !locked.admit(store, "/app.js"))
    drain()
    check(
        "a file that cannot be read does not quarantine the UI",
        store.tampered == nil && store.current == version && fm.fileExists(atPath: lockedFile) && heard.isEmpty
    )
    try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: lockedFile)
    check("once it can be read it is checked again and served", locked.admit(store, "/app.js"))
    let lockedManifest = locked.dir.appendingPathComponent(DenextOtaStore.manifestPath).path
    try fm.setAttributes([.posixPermissions: 0], ofItemAtPath: lockedManifest)
    check("the stored manifest that cannot be read is refused to the page", !locked.admit(store, "/_denext/ota.json") && store.tampered == nil)
    store = locked.launch(key: signed)
    check("a launch whose stored manifest cannot be read serves the bundled UI", store.prepareLaunch().directory == nil)
    check(
        "a stored manifest that cannot be read does not quarantine the UI",
        store.tampered == nil && store.current == version && fm.fileExists(atPath: lockedManifest)
    )
    locked.defaults.set(version, forKey: "denext.ota.pending")
    locked.defaults.set(1, forKey: "denext.ota.trialAttempts")
    let lockedTrial = locked.launch(key: signed).prepareLaunch()
    check(
        "a pending UI that cannot be read is not tried this launch and keeps its trial",
        lockedTrial.directory == nil && !lockedTrial.trial &&
            locked.defaults.string(forKey: "denext.ota.pending") == version &&
            locked.defaults.integer(forKey: "denext.ota.trialAttempts") == 1
    )
    try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: lockedManifest)
    let unlocked = locked.launch(key: signed).prepareLaunch()
    check("the next launch that can read it tries it", unlocked.directory?.path == locked.dir.path && unlocked.trial)

    // ---- unsigned (no key embedded): the files are still checked -----------------------------
    let unsigned = try device("unsigned", manifest: storedManifest(signature: nil))
    store = unsigned.launch(key: .unset)
    check("without a key, a UI whose manifest matches its version is served", store.prepareLaunch().directory != nil)
    try unsigned.tamper("assets/logo.svg", "<svg onload=evil()/>")
    check("without a key, a changed file is still refused", !unsigned.admit(store, "/assets/logo.svg"))

    // ---- downloading the same version again lifts the quarantine -----------------------------
    try unsigned.install(storedManifest(signature: nil))
    store.stage(version, sequence: 7)
    check("a fresh download of a quarantined version is served again", unsigned.admit(store, "/assets/logo.svg"))

    // ---- AU6 lows: a signed expiry (v4), loopback only in debug builds, directories ----------
    let now = Int(Date().timeIntervalSince1970)
    func manifest(_ extra: JSObject, sequence: Bool = true) -> JSObject {
        var object: JSObject = [
            "version": version,
            "files": manifestFiles.map { ["path": $0.path, "sha256": $0.sha256, "size": Int($0.size)] as JSObject } as JSArray,
            "notes": "hello",
        ]
        if sequence { object["sequence"] = 7 }
        for (name, value) in extra { object[name] = value }
        return object
    }
    func refusal(_ object: JSObject, baseUrl: String = "http://127.0.0.1/ui") -> String? {
        do {
            _ = try DenextOtaStore.ApplyRequest(baseUrl: baseUrl, headers: nil, manifest: object)
            return nil
        } catch let error as DenextOtaStore.OtaError {
            return error.code
        } catch {
            return "\(error)"
        }
    }
    check("expiry: a manifest past its expiresAt is refused (expired)", refusal(manifest(["expiresAt": now - 1])) == "expired")
    check("expiry: a manifest before its expiresAt is accepted", refusal(manifest(["expiresAt": now + 3600])) == nil)
    check("expiry: an expiresAt without a sequence is invalid", refusal(manifest(["expiresAt": now + 3600], sequence: false)) == "invalid")
    let future = Int64(now + 86_400)
    let v4 = DenextOtaStore.signaturePayload(version: version, required: false, notes: "hello", sequence: 7, minNative: nil, nativeFingerprint: nil, expiresAt: future)
    let v4Signature = (try key.signature(for: v4)).rawRepresentation.base64EncodedString()
    let expiringRequest = try DenextOtaStore.ApplyRequest(
        baseUrl: "http://127.0.0.1/ui",
        headers: nil,
        manifest: manifest(["expiresAt": Int(future), "signature": v4Signature])
    )
    let expiring = try device("expiring", manifest: DenextOtaStore.storedManifest(expiringRequest))
    check("expiry: the stored v4 manifest keeps expiresAt and verifies at launch", expiring.launch(key: signed).prepareLaunch().directory != nil)
    var altered = try JSONSerialization.jsonObject(with: Data(contentsOf: expiring.dir.appendingPathComponent(DenextOtaStore.manifestPath))) as! [String: Any]
    altered["expiresAt"] = future + 1
    try expiring.install(JSONSerialization.data(withJSONObject: altered))
    check("expiry: a stored expiresAt changed on the device fails the signature", expiring.launch(key: signed).prepareLaunch().directory == nil)
    print("payload-v4 \(version) \(DenextOtaStore.signaturePayload(version: version, required: true, notes: "n", sequence: 7, minNative: 3, nativeFingerprint: nil, expiresAt: 1_800_000_000).base64EncodedString())")

    DenextOtaStore.isDebugBuild = false
    check("release build: an unsigned UI from loopback is refused (insecure)", refusal(manifest([:])) == "insecure")
    DenextOtaStore.isDebugBuild = true
    check("debug build: an unsigned UI from loopback is accepted", refusal(manifest([:])) == nil)
    check("a baseUrl with credentials is invalid", refusal(manifest([:]), baseUrl: "http://user:pw@127.0.0.1/ui") == "invalid")
    check("a baseUrl with a backslash is invalid", refusal(manifest([:]), baseUrl: "http://127.0.0.1\\@evil.example/ui") == "invalid")

    // The platform stamp (`denext export --platform`), checked natively too: a signed export of
    // another target is refused by the shell, not only by the page.
    func stamped(_ stamp: String?, platform: Any?) -> JSObject {
        var list = manifestFiles
        if let stamp {
            list.append(DenextOtaStore.ManifestFile(path: "_denext/platform.txt", sha256: DenextOtaStore.sha256Hex(Data(stamp.utf8)), size: Int64(stamp.utf8.count)))
        }
        var object: JSObject = [
            "version": DenextOtaStore.manifestVersion(list),
            "files": list.map { ["path": $0.path, "sha256": $0.sha256, "size": Int($0.size)] as JSObject } as JSArray,
            "sequence": 7,
        ]
        if let platform = platform as? JSValue { object["platform"] = platform }
        return object
    }
    check("platform: an iOS export is accepted", refusal(stamped("ios", platform: "ios")) == nil)
    check("platform: an iOS stamp without the field is accepted", refusal(stamped("ios", platform: nil)) == nil)
    check("platform: an Android export is refused (platform_mismatch)", refusal(stamped("android", platform: "android")) == "platform_mismatch")
    check("platform: an Android stamp without the field is refused", refusal(stamped("android", platform: nil)) == "platform_mismatch")
    check("platform: the field without a matching stamp is refused", refusal(stamped(nil, platform: "ios")) == "platform_mismatch")
    check("platform: a field that disagrees with the stamp is refused", refusal(stamped("android", platform: "ios")) == "platform_mismatch")
    check("platform: a field that is not a string is invalid", refusal(stamped("ios", platform: 1)) == "invalid")
    // An app that embeds a public key takes only its own platform's stamped export: a web export
    // signed with the same key is not an iOS UI. Unsigned (pinned-origin) apps take it as before.
    func platformRefusal(_ stamp: String?, platform: String?, signed: Bool) -> String? {
        var list = manifestFiles
        if let stamp {
            list.append(DenextOtaStore.ManifestFile(path: "_denext/platform.txt", sha256: DenextOtaStore.sha256Hex(Data(stamp.utf8)), size: Int64(stamp.utf8.count)))
        }
        do {
            try DenextOtaStore.checkPlatform(platform, files: list, signed: signed)
            return nil
        } catch let error as DenextOtaStore.OtaError {
            return error.code
        } catch {
            return "\(error)"
        }
    }
    check("platform: a signed app refuses an unstamped export (platform_mismatch)", platformRefusal(nil, platform: nil, signed: true) == "platform_mismatch")
    check("platform: a signed app takes its own platform's export", platformRefusal("ios", platform: "ios", signed: true) == nil)
    check("platform: a signed app refuses another platform's export", platformRefusal("android", platform: "android", signed: true) == "platform_mismatch")
    check("platform: an unsigned app takes an unstamped export", platformRefusal(nil, platform: nil, signed: false) == nil)
    check("platform: an app without a key does not sign updates", !DenextOtaStore.signsUpdates)

    // ---- the app the release is for: a signed appId (appSignature, the v5 payload) -----------
    // A feed for another app that shares the signing key cannot install its UI here.
    func appPayload(_ appId: String) -> Data {
        DenextOtaStore.appSignaturePayload(version: version, required: false, notes: "hello", sequence: 7, minNative: nil, nativeFingerprint: nil, expiresAt: nil, appId: appId)
    }
    func appSignature(_ appId: String, by signer: P256.Signing.PrivateKey = key) -> String {
        (try! signer.signature(for: appPayload(appId))).rawRepresentation.base64EncodedString()
    }
    func appRefusal(_ appId: String?, _ signature: String?, own: String?, key config: DenextOtaStore.PublicKeyConfig) -> String? {
        do {
            try DenextOtaStore.checkApp(appId, appSignature: signature, payload: appId.map(appPayload), own: own, key: config)
            return nil
        } catch let error as DenextOtaStore.OtaError {
            return error.code
        } catch {
            return "\(error)"
        }
    }
    let ownId = "com.example.app"
    check("app: a signed app takes a release signed for it", appRefusal(ownId, appSignature(ownId), own: ownId, key: signed) == nil)
    check(
        "app: a signed app refuses another app's validly signed release (app_mismatch)",
        appRefusal("com.example.other", appSignature("com.example.other"), own: ownId, key: signed) == "app_mismatch"
    )
    check("app: a signed app refuses a release that names no app (app_mismatch)", appRefusal(nil, nil, own: ownId, key: signed) == "app_mismatch")
    check(
        "app: a signed app refuses an appId its appSignature does not cover (signature)",
        appRefusal(ownId, appSignature("com.example.other"), own: ownId, key: signed) == "signature"
    )
    check("app: a signed app refuses an appId without an appSignature (signature)", appRefusal(ownId, nil, own: ownId, key: signed) == "signature")
    check(
        "app: a signed app refuses an appSignature by another key (signature)",
        appRefusal(ownId, appSignature(ownId, by: otherKey), own: ownId, key: signed) == "signature"
    )
    check("app: an unsigned app takes a release that names no app", appRefusal(nil, nil, own: ownId, key: .unset) == nil)
    check("app: an unsigned app refuses another app's release (app_mismatch)", appRefusal("com.example.other", nil, own: ownId, key: .unset) == "app_mismatch")
    check("app: a binary that does not know its id takes a release that names no app", appRefusal(nil, nil, own: nil, key: signed) == nil)
    check("app: an appId without a sequence is invalid", refusal(manifest(["appId": ownId], sequence: false)) == "invalid")
    check("app: an appId that is not an app id is invalid", refusal(manifest(["appId": "com.example/app"])) == "invalid")
    let ownAppSignature = appSignature(ownId)
    let appRequest = try DenextOtaStore.ApplyRequest(
        baseUrl: "http://127.0.0.1/ui",
        headers: nil,
        manifest: manifest(["appId": ownId, "appSignature": ownAppSignature])
    )
    let storedApp = try JSONSerialization.jsonObject(with: DenextOtaStore.storedManifest(appRequest)) as! [String: Any]
    check(
        "app: the stored manifest keeps appId and appSignature",
        storedApp["appId"] as? String == ownId && storedApp["appSignature"] as? String == ownAppSignature
    )
    print("payload-v5 \(version) \(DenextOtaStore.appSignaturePayload(version: version, required: true, notes: "n", sequence: 7, minNative: 3, nativeFingerprint: nil, expiresAt: 1_800_000_000, appId: "com.example.app").base64EncodedString())")

    let folders = try device("folders", manifest: storedManifest(signature: sign(key)))
    store = folders.launch(key: signed)
    _ = store.prepareLaunch()
    check("a request for a directory of the UI is refused without quarantining", !folders.admit(store, "/assets") && store.tampered == nil)
    check("the UI is still served after it", folders.admit(store, "/assets/logo.svg"))

    // ---- the /_capacitor_file_ guard could not be installed ---------------------------------
    // Without DenextOtaFileGuard a /_capacitor_file_ request would read a downloaded UI unchecked,
    // so the process serves none (fail closed), unless the app opted out.
    let unguarded = try device("unguarded", manifest: storedManifest(signature: sign(key)))
    store = unguarded.launch(key: signed)
    check("no file guard: the launch first chooses the downloaded UI", store.prepareLaunch().directory?.path == unguarded.dir.path)
    check("no file guard: the bridge is told to serve the bundled UI", store.settleFileGuard(failure: "no handler", optedOut: false))
    check("no file guard: the reason is kept for the plugin's refusals", store.guardUnavailable == "no handler")
    check("no file guard: no downloaded file is served", !unguarded.admit(store, "/app.js") && !unguarded.admit(store, "/index.html"))
    check(
        "no file guard: nothing is quarantined",
        store.tampered == nil && store.current == version && fm.fileExists(atPath: unguarded.dir.path)
    )
    let notice = store.takeGuardNotice()
    check("no file guard: the plugin hears it once", notice?.version == version && store.takeGuardNotice() == nil)
    check("no file guard: the bundled UI is still served", store.admit(unguarded.bundled.path + "/index.html", servedFrom: unguarded.bundled.path))
    check("no file guard: a quarantine falls back to the bundled UI", store.fallbackDirectory() == nil)
    check("no file guard: a later bridge gets the bundled UI", store.prepareLaunch().directory == nil)
    unguarded.defaults.set(version, forKey: "denext.ota.pending")
    unguarded.defaults.set(0, forKey: "denext.ota.trialAttempts")
    store = unguarded.launch(key: signed)
    let unguardedTrial = store.prepareLaunch()
    _ = store.settleFileGuard(failure: "no handler", optedOut: false)
    check(
        "no file guard: a trial keeps its attempt",
        unguardedTrial.trial && store.pending == version && unguarded.defaults.integer(forKey: "denext.ota.trialAttempts") == 0
    )
    unguarded.defaults.removeObject(forKey: "denext.ota.pending")
    store = unguarded.launch(key: signed)
    _ = store.prepareLaunch()
    check(
        "no file guard, opted out: the downloaded UI is served",
        !store.settleFileGuard(failure: "own handler", optedOut: true) && store.guardUnavailable == nil &&
            unguarded.admit(store, "/app.js") && store.takeGuardNotice() == nil
    )
    store = unguarded.launch(key: signed)
    _ = store.prepareLaunch()
    check(
        "file guard in place: the downloaded UI is served",
        !store.settleFileGuard(failure: nil, optedOut: false) && unguarded.admit(store, "/app.js")
    )
    let bundledOnly = try device("unguarded-bundled", current: false, manifest: storedManifest(signature: sign(key)))
    store = bundledOnly.launch(key: signed)
    check("no file guard: a launch of the bundled UI", store.prepareLaunch().directory == nil)
    check(
        "no file guard: a launch of the bundled UI keeps it, with no notice",
        !store.settleFileGuard(failure: "no handler", optedOut: false) && store.takeGuardNotice() == nil &&
            !bundledOnly.admit(store, "/app.js")
    )
} catch {
    print("FAIL harness error: \(error)")
    failures += 1
}

for d in devices { UserDefaults.standard.removePersistentDomain(forName: d.suite) }
print("done \(failures)")
