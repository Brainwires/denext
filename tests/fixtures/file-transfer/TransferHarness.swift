// Drives DenextTransferManager.swift (the iOS half of denext's file transfers) on macOS against
// the local server tests/mobile-file-transfer-native.test.ts runs: downloads with progress, a
// pause and a resume from resume data, multipart and binary uploads, an HTTP error, a cancel, the
// saved records a new manager reads back, the refusals, and a reused id's old task kept out of
// the new transfer (its late response bytes, and its pause's resume data, whose completion handler
// the harness captures and calls itself). Foundation's URLSession is the same API on iOS; the background session itself
// needs an app, so the harness uses the foreground one.
// Prints `ok <check>` / `FAIL <check>: why`, then `done <failures>`.
import Foundation
import ObjectiveC

let args = CommandLine.arguments
let base = args[1]
let work = URL(fileURLWithPath: args[2], isDirectory: true)
DenextTransferManager.rootOverride = work.appendingPathComponent("root", isDirectory: true)
let stateDir = work.appendingPathComponent("state", isDirectory: true)
var failures = 0

func check(_ name: String, _ ok: Bool, _ why: @autoclosure () -> String = "") {
    if ok { print("ok \(name)") } else { failures += 1; print("FAIL \(name): \(why())") }
}

/// Run the main queue (the manager sends events there) until `cond` holds or `seconds` pass.
func wait(_ seconds: TimeInterval, _ cond: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while !cond() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    return cond()
}

var events: [[String: Any]] = []
func eventsFor(_ id: String) -> [[String: Any]] { events.filter { $0["id"] as? String == id } }
func last(_ id: String, _ type: String) -> [String: Any]? { eventsFor(id).last { $0["type"] as? String == type } }
func settled(_ id: String) -> Bool {
    eventsFor(id).contains { ["done", "failed", "cancelled"].contains($0["type"] as? String ?? "") }
}

func record(_ id: String, _ kind: String, _ path: String, url: String, method: String = "GET",
            multipart: DenextTransferRecord.Multipart? = nil, mimeType: String? = nil,
            headers: [String: String] = [:]) -> DenextTransferRecord {
    DenextTransferRecord(id: id, kind: kind, url: url, directory: "DATA", path: path, method: method,
                         headers: headers, multipart: multipart, mimeType: mimeType, background: false,
                         state: "running", bytes: 0, total: nil, status: nil, error: nil, code: nil,
                         resumable: false, body: nil, responseHeaders: nil)
}

let manager = DenextTransferManager(identifier: "dev.denext.transfer.test", directory: stateDir)
_ = manager.observe { events.append($0) }

// 1. A download with progress lands in the app folder.
do {
    try manager.start(record("d1", "download", "files/big.bin", url: "\(base)/big"))
    _ = wait(30) { settled("d1") }
    let done = last("d1", "done")
    check("a download finishes", done != nil, "\(eventsFor("d1"))")
    let progress = eventsFor("d1").filter { $0["type"] as? String == "progress" }
    check("a download reports progress with the total", !progress.isEmpty &&
          (progress.last?["total"] as? Int64) == 1_048_576, "\(progress.count) \(String(describing: progress.last))")
    let file = DenextTransferManager.rootOverride!.appendingPathComponent("DATA/files/big.bin")
    let data = (try? Data(contentsOf: file)) ?? Data()
    check("the downloaded file is complete", data.count == 1_048_576 && data.last == UInt8(1_048_575 % 251),
          "\(data.count) bytes")
    check("done carries the file path", (done?["file"] as? String) == file.path, "\(String(describing: done?["file"]))")
} catch { check("a download finishes", false, "\(error)") }

// 2. A pause keeps resume data and a resume continues with a range request.
do {
    try manager.start(record("d2", "download", "slow.bin", url: "\(base)/slow"))
    _ = wait(20) { (eventsFor("d2").last { $0["type"] as? String == "progress" }?["bytes"] as? Int64 ?? 0) > 0 }
    check("pause answers true for a running download", manager.pause("d2"))
    _ = wait(10) { last("d2", "paused") != nil }
    let paused = last("d2", "paused")
    check("a paused download is resumable", paused?["resumable"] as? Bool == true, "\(String(describing: paused))")
    check("resume answers true", (try? manager.resume("d2")) == true)
    // The paused task's own completion (cancelled) can arrive after the resume started its
    // successor; it must not settle the resumed download. Delivered here on purpose, so the race is
    // not left to timing.
    let stale = URLSession.shared.downloadTask(with: URL(string: "\(base)/slow")!)
    stale.taskDescription = "d2"
    manager.urlSession(URLSession.shared, task: stale,
                       didCompleteWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
    _ = wait(60) { settled("d2") }
    check("the resumed download finishes", last("d2", "done") != nil, "\(eventsFor("d2").suffix(3))")
    check("a superseded task's late completion does not fail the resumed download",
          last("d2", "failed") == nil, "\(eventsFor("d2").suffix(3))")
    let file = DenextTransferManager.rootOverride!.appendingPathComponent("DATA/slow.bin")
    let data = (try? Data(contentsOf: file)) ?? Data()
    check("the resumed file is complete and in order", data.count == 524_288 &&
          data.enumerated().allSatisfy { $0.element == UInt8($0.offset % 251) }, "\(data.count) bytes")
}

// 2b. A resume right after the pause, before its resume data arrived, still continues from it.
do {
    try manager.start(record("d5", "download", "quick.bin", url: "\(base)/slow"))
    _ = wait(20) { (eventsFor("d5").last { $0["type"] as? String == "progress" }?["bytes"] as? Int64 ?? 0) > 0 }
    check("pause answers true (quick)", manager.pause("d5"))
    check("an immediate resume answers true", (try? manager.resume("d5")) == true)
    _ = wait(60) { settled("d5") }
    let restarts = eventsFor("d5").filter { $0["type"] as? String == "started" }.dropFirst()
    check("an immediate resume continues from the paused bytes",
          restarts.count == 1 && (restarts.first?["bytes"] as? Int64 ?? 0) > 0, "\(Array(restarts))")
    check("the quickly resumed download finishes", last("d5", "done") != nil && last("d5", "failed") == nil,
          "\(eventsFor("d5").suffix(3))")
    let file = DenextTransferManager.rootOverride!.appendingPathComponent("DATA/quick.bin")
    let data = (try? Data(contentsOf: file)) ?? Data()
    check("the quickly resumed file is complete and in order", data.count == 524_288 &&
          data.enumerated().allSatisfy { $0.element == UInt8($0.offset % 251) }, "\(data.count) bytes")
} catch { check("pause answers true (quick)", false, "\(error)") }

// 3. A multipart upload, its fields and its response.
do {
    let source = DenextTransferManager.rootOverride!.appendingPathComponent("DATA/up/photo.jpg")
    try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data((0..<100_000).map { UInt8($0 % 256) }).write(to: source)
    let part = DenextTransferRecord.Multipart(field: "photo", fileName: "photo.jpg", mimeType: "image/jpeg",
                                              fields: ["album": "trip", "note": "a \"quoted\" one"])
    try manager.start(record("u1", "upload", "up/photo.jpg", url: "\(base)/upload", method: "POST",
                             multipart: part, headers: ["x-token": "t1"]))
    _ = wait(30) { settled("u1") }
    let done = last("u1", "done")
    check("a multipart upload finishes", done != nil, "\(eventsFor("u1"))")
    let body = done?["body"] as? String ?? ""
    check("the server read the file part and the fields",
          body.contains("\"photo\":100000") && body.contains("\"album\":\"trip\"") && body.contains("\"token\":\"t1\""), body)
    check("an upload reports its status and headers", (done?["status"] as? Int) == 200 &&
          ((done?["headers"] as? [String: String])?["x-echo"]) == "yes", "\(String(describing: done))")
    check("an upload reports progress", eventsFor("u1").contains { $0["type"] as? String == "progress" })
} catch { check("a multipart upload finishes", false, "\(error)") }

// 4. A binary upload (PUT, the file as the body).
do {
    try manager.start(record("u2", "upload", "up/photo.jpg", url: "\(base)/raw", method: "PUT", mimeType: "image/jpeg"))
    _ = wait(30) { settled("u2") }
    let body = last("u2", "done")?["body"] as? String ?? ""
    check("a binary upload sends the file as the body", body == "PUT image/jpeg 100000", body)
} catch { check("a binary upload sends the file as the body", false, "\(error)") }

// 5. An HTTP error fails the transfer with its status.
do {
    try manager.start(record("d3", "download", "missing.bin", url: "\(base)/missing"))
    _ = wait(30) { settled("d3") }
    let failed = last("d3", "failed")
    check("a 404 fails with code HTTP and the status", failed?["code"] as? String == "HTTP" &&
          failed?["status"] as? Int == 404, "\(String(describing: failed))")
    let file = DenextTransferManager.rootOverride!.appendingPathComponent("DATA/missing.bin")
    check("a failed download leaves no file", !FileManager.default.fileExists(atPath: file.path))
} catch { check("a 404 fails with code HTTP and the status", false, "\(error)") }

// 6. A cancel.
do {
    try manager.start(record("d4", "download", "cancelled.bin", url: "\(base)/slow"))
    _ = wait(20) { (eventsFor("d4").last { $0["type"] as? String == "progress" }?["bytes"] as? Int64 ?? 0) > 0 }
    check("cancel answers true", manager.cancel("d4"))
    _ = wait(10) { settled("d4") }
    check("a cancelled transfer says so", last("d4", "cancelled") != nil && last("d4", "failed") == nil,
          "\(eventsFor("d4").suffix(2))")
} catch { check("cancel answers true", false, "\(error)") }

// 7. The refusals.
do {
    try manager.start(record("bad1", "download", "../escape.bin", url: "\(base)/big"))
    check("a path with .. is refused", false)
} catch { check("a path with .. is refused", "\(error)".contains("not a relative path"), "\(error)") }
do {
    try manager.start(record("bad2", "download", "x.bin", url: "file:///etc/hosts"))
    check("a non-http URL is refused", false)
} catch { check("a non-http URL is refused", "\(error)".contains("not an http(s) URL"), "\(error)") }
do {
    try manager.start(record("bad3", "upload", "nope.bin", url: "\(base)/upload", method: "POST"))
    check("an upload of a missing file is refused", false)
} catch { check("an upload of a missing file is refused", (error as? DenextTransferError)?.code == "NOT_FOUND", "\(error)") }

// 8. The records outlive the manager; forget drops a finished one.
let again = DenextTransferManager(identifier: "dev.denext.transfer.test2", directory: stateDir)
let states = Dictionary(uniqueKeysWithValues: again.list().map { ($0["id"] as! String, $0["state"] as! String) })
check("a new manager reads the saved records", states["d1"] == "done" && states["u1"] == "done" &&
      states["d3"] == "failed" && states["d4"] == "cancelled", "\(states)")
check("forget drops a finished record", again.forget("d1") && !again.list().contains { $0["id"] as? String == "d1" })
check("pause refuses a finished transfer", !again.pause("u1"))

// 9. The multipart body on its own.
do {
    let src = work.appendingPathComponent("part-src.txt")
    try Data("hello".utf8).write(to: src)
    let out = work.appendingPathComponent("part.body")
    try DenextTransferManager.writeMultipartBody(source: src, to: out, boundary: "B", field: "f", fileName: "a\"b.txt",
                                                 mimeType: "text/plain", fields: ["k": "v"])
    let text = String(decoding: try Data(contentsOf: out), as: UTF8.self)
    let expected = "--B\r\nContent-Disposition: form-data; name=\"k\"\r\n\r\nv\r\n" +
        "--B\r\nContent-Disposition: form-data; name=\"f\"; filename=\"a%22b.txt\"\r\nContent-Type: text/plain\r\n\r\n" +
        "hello\r\n--B--\r\n"
    check("the multipart body is framed as RFC 7578 asks", text == expected, text.debugDescription)
} catch { check("the multipart body is framed as RFC 7578 asks", false, "\(error)") }

// 10. An id cancelled, forgotten and started again: the old task's late response bytes stay out of
// the new transfer's body. Delivered here on purpose, so the race is not left to timing.
do {
    try manager.start(record("u3", "upload", "up/photo.jpg", url: "\(base)/raw", method: "PUT", mimeType: "image/jpeg"))
    check("a reused id: cancel answers true", manager.cancel("u3"))
    check("a reused id: forget answers true", manager.forget("u3"))
    try manager.start(record("u3", "upload", "up/photo.jpg", url: "\(base)/raw", method: "PUT", mimeType: "image/jpeg"))
    let stale = URLSession.shared.dataTask(with: URL(string: "\(base)/raw")!)
    stale.taskDescription = "u3"
    manager.urlSession(URLSession.shared, dataTask: stale, didReceive: Data("stale ".utf8))
    _ = wait(30) { last("u3", "done") != nil || last("u3", "failed") != nil }
    let body = last("u3", "done")?["body"] as? String ?? ""
    check("a reused id's old task does not write into the new transfer's body", body == "PUT image/jpeg 100000", body)
} catch { check("a reused id's old task does not write into the new transfer's body", false, "\(error)") }

// 11. An id paused, cancelled, forgotten, started again and paused again: the first pause's
// resume data arrives last. URLSession calls a cancel(byProducingResumeData:) completion when it
// likes, so the harness swaps that method on the download task class for one that keeps the
// handler (and cancels the task plainly), then calls the handlers in the order it wants.
nonisolated(unsafe) var capturing = false
nonisolated(unsafe) var captured: [(Data?) -> Void] = []
func captureResumeHandlers() -> Bool {
    let probe = URLSession(configuration: .default).downloadTask(with: URL(string: base)!)
    defer { probe.cancel() }
    guard let cls = object_getClass(probe) else { return false }
    let sel = NSSelectorFromString("cancelByProducingResumeData:")
    guard let method = class_getInstanceMethod(cls, sel) else { return false }
    typealias Original = @convention(c) (AnyObject, Selector, @escaping @convention(block) (Data?) -> Void) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Original.self)
    let replacement: @convention(block) (AnyObject, @escaping @convention(block) (Data?) -> Void) -> Void = { task, handler in
        if capturing {
            captured.append(handler)
            (task as? URLSessionTask)?.cancel()
        } else {
            original(task, sel, handler)
        }
    }
    class_replaceMethod(cls, sel, imp_implementationWithBlock(replacement), method_getTypeEncoding(method))
    return true
}
do {
    check("the harness captures resume-data handlers", captureResumeHandlers(), "no cancelByProducingResumeData: to swap")
    capturing = true
    try manager.start(record("d6", "download", "reused.bin", url: "\(base)/slow"))
    _ = wait(20) { (eventsFor("d6").last { $0["type"] as? String == "progress" }?["bytes"] as? Int64 ?? 0) > 0 }
    check("a reused id: the first pause answers true", manager.pause("d6"))
    check("a reused id: cancel after the pause answers true", manager.cancel("d6"))
    check("a reused id: forget answers true (pause)", manager.forget("d6"))
    _ = wait(0.2) { false }
    let before = eventsFor("d6").count
    try manager.start(record("d6", "download", "reused.bin", url: "\(base)/slow"))
    _ = wait(20) {
        (eventsFor("d6").dropFirst(before).last { $0["type"] as? String == "progress" }?["bytes"] as? Int64 ?? 0) > 0
    }
    check("a reused id: the second pause answers true", manager.pause("d6"))
    capturing = false
    check("both pauses' handlers were captured", captured.count == 2, "\(captured.count)")
    if captured.count == 2 {
        let resumeFile = stateDir.appendingPathComponent("transfers/d6.resume")
        captured[0](Data("the first task's resume data".utf8))
        _ = wait(0.5) { false }
        let written = (try? Data(contentsOf: resumeFile)).map { String(decoding: $0, as: UTF8.self) }
        check("a stale pause callback does not write the new transfer's resume data", written == nil,
              written ?? "")
        check("a stale pause callback does not settle the new transfer's pause",
              !eventsFor("d6").dropFirst(before).contains { $0["type"] as? String == "paused" },
              "\(eventsFor("d6").dropFirst(before).filter { $0["type"] as? String == "paused" })")
        if written == nil {
            // The new transfer is still waiting for its own data: a resume now continues from it.
            check("a reused id: resume answers true while its pause settles", (try? manager.resume("d6")) == true)
            _ = wait(0.3) { false }
            let started = eventsFor("d6").filter { $0["type"] as? String == "started" }.count
            check("the resume waits for the new transfer's own pause", started == 2, "\(started) starts")
            captured[1](nil)
            _ = wait(60) { last("d6", "done") != nil || last("d6", "failed") != nil }
            check("the reused id's download finishes", last("d6", "done") != nil, "\(eventsFor("d6").suffix(3))")
        } else {
            check("a reused id: resume answers true while its pause settles", false, "skipped: stale resume data on disk")
        }
    }
} catch { check("a reused id: the first pause answers true", false, "\(error)") }

print("done \(failures)")
exit(failures == 0 ? 0 : 1)
