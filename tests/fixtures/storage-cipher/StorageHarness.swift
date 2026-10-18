// Drives DenextStorageStore.swift (the iOS half of `openKeyValueStore()`) on macOS, in two
// builds: against the system SQLite (`plain`: a key is refused, nothing is written in the
// clear) and against SQLCipher (`cipher`: an encrypted store, its migration out of the plain
// database, the file unreadable without the key, a wrong key refused). Prints `ok <check>` /
// `FAIL <check>: why`, then `done <failures>`.
import Foundation

let mode = CommandLine.arguments[1]
let folder = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
var failures = 0

func check(_ name: String, _ ok: Bool, _ why: @autoclosure () -> String = "") {
    if ok { print("ok \(name)") } else { failures += 1; print("FAIL \(name): \(why())") }
}

func code(_ fn: () throws -> Void) -> String {
    do {
        try fn()
        return "none"
    } catch let error as DenextStorageError {
        return error.code
    } catch {
        return "\(error)"
    }
}

let store = DenextStorageStore(folder: folder)
do {
    try store.setMany("prefs", [("theme", "dark"), ("font", "serif")], key: nil)
    try store.setMany("secret", [("token", "PLAINTEXT-MARKER-123")], key: nil)
    check("a plain store reads back", try store.getMany("prefs", ["theme", "font", "nope"], key: nil) == ["dark", "serif", nil])
    try store.removeMany("prefs", ["font"], key: nil)
    check("a plain store lists its keys", try store.keys("prefs", key: nil) == ["theme"])
} catch { check("a plain store reads back", false, "\(error)") }

if mode == "plain" {
    check("the system SQLite has no cipher", !DenextStorageStore.cipherAvailable())
    check("a key is refused without SQLCipher",
          code { _ = try store.getMany("secret", ["token"], key: "k1") } == "ENCRYPTION_UNAVAILABLE")
    check("a refused key writes no encrypted file",
          !FileManager.default.fileExists(atPath: store.encryptedFile("secret").path))
    check("a refused key leaves the plain rows", (try? store.getMany("secret", ["token"], key: nil)) == ["PLAINTEXT-MARKER-123"])
} else {
    check("SQLCipher answers cipher_version", DenextStorageStore.cipherAvailable())
    do {
        check("the first encrypted open moves the store's rows in",
              try store.getMany("secret", ["token"], key: "k1") == ["PLAINTEXT-MARKER-123"])
        check("the plain database no longer holds them", try store.keys("secret", key: nil) == [])
        check("other stores stay plain", try store.getMany("prefs", ["theme"], key: nil) == ["dark"])
        try store.setMany("secret", [("pin", "4321")], key: "k1")
        check("an encrypted store writes and lists", try store.keys("secret", key: "k1") == ["pin", "token"])
    } catch { check("the first encrypted open moves the store's rows in", false, "\(error)") }
    let bytes = (try? Data(contentsOf: store.encryptedFile("secret"))) ?? Data()
    check("the encrypted file exists", bytes.count > 0)
    check("the encrypted file is not a SQLite file", !bytes.starts(with: Data("SQLite format 3".utf8)))
    check("the encrypted file holds no plaintext", bytes.range(of: Data("PLAINTEXT-MARKER".utf8)) == nil)
    let leftovers = ["kv.sqlite", "kv.sqlite-wal"].map {
        (try? Data(contentsOf: folder.appendingPathComponent($0))) ?? Data()
    }
    check("the plain database keeps no copy of the moved rows",
          leftovers.allSatisfy { $0.range(of: Data("PLAINTEXT-MARKER".utf8)) == nil })
    let other = DenextStorageStore(folder: folder)
    check("a wrong key is refused", code { _ = try other.keys("secret", key: "nope") } == "WRONG_KEY")
    check("the right key opens it again", (try? other.getMany("secret", ["pin"], key: "k1")) == ["4321"])
    check("a key with a quote works", code {
        try other.setMany("quoted", [("a", "b")], key: "it's")
        _ = try DenextStorageStore(folder: folder).getMany("quoted", ["a"], key: "it's")
    } == "none")
}
print("done \(failures)")
exit(failures == 0 ? 0 : 1)
