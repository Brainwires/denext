// Drives the generated DenextOtaStore through launches and served requests on macOS (each launch
// a new store over the same directory and defaults). Prints "ok <name>" / "FAIL <name>" per check.
import Capacitor
import CryptoKit
import Foundation

let work = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
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

    init(_ name: String) {
        root = work.appendingPathComponent(name).appendingPathComponent("denext-ota", isDirectory: true)
        suite = "dev.denext.ota-reverify.\(name).\(UUID().uuidString)"
    }

    /// A new process.
    func launch(key: DenextOtaStore.PublicKeyConfig) -> DenextOtaStore {
        DenextOtaStore(root: root, defaults: defaults, publicKey: key)
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
    check("the bundled UI is not checked", store.admit("/App.app/public/app.js", servedFrom: "/App.app/public"))

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
} catch {
    print("FAIL harness error: \(error)")
    failures += 1
}

for d in devices { UserDefaults.standard.removePersistentDomain(forName: d.suite) }
print("done \(failures)")
