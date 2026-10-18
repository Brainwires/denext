// Drives DenextTransferHttp.java (the HTTP half of denext's Android file transfers, plain Java)
// against the local server tests/mobile-file-transfer-native.test.ts runs: a download with
// progress, a stop and a resume with a range request, a server that ignores the range, a stale
// partial file (416), multipart and binary uploads, and an HTTP error. Prints `ok <check>` /
// `FAIL <check>: why`, then `done <failures>`.
package dev.denext.transfer;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

public final class TransferHarness {
    static int failures = 0;

    static void check(String name, boolean ok, String why) {
        if (ok) {
            System.out.println("ok " + name);
        } else {
            failures++;
            System.out.println("FAIL " + name + ": " + why);
        }
    }

    /** A listener that records progress and stops once {@code stopAt} bytes have arrived. */
    static final class Recorder implements DenextTransferHttp.Listener {
        final List<long[]> seen = new ArrayList<>();
        final long stopAt;

        Recorder(long stopAt) {
            this.stopAt = stopAt;
        }

        @Override
        public void progress(long bytes, long total) {
            seen.add(new long[] {bytes, total});
        }

        @Override
        public boolean stopped() {
            return stopAt >= 0 && !seen.isEmpty() && seen.get(seen.size() - 1)[0] >= stopAt;
        }
    }

    static boolean pattern(byte[] data, int size) {
        if (data.length != size) return false;
        for (int i = 0; i < size; i++) {
            if (data[i] != (byte) (i % 251)) return false;
        }
        return true;
    }

    public static void main(String[] args) throws Exception {
        String base = args[0];
        File work = new File(args[1]);
        Map<String, String> none = new HashMap<>();

        // 1. A download with progress.
        File part = new File(work, "big.bin.denext-part");
        Recorder r1 = new Recorder(-1);
        DenextTransferHttp.Result big = DenextTransferHttp.download(base + "/big", none, part, r1);
        check("a download finishes with 200", big.status == 200, "status " + big.status);
        check("a download reports progress with the total", !r1.seen.isEmpty()
            && r1.seen.get(r1.seen.size() - 1)[1] == 1_048_576, "" + r1.seen.size());
        check("the downloaded file is complete", pattern(Files.readAllBytes(part.toPath()), 1_048_576),
            part.length() + " bytes");

        // 2. Stopped part-way, then resumed with a range request.
        File slow = new File(work, "slow.bin.denext-part");
        Recorder r2 = new Recorder(100_000);
        boolean stopped = false;
        try {
            DenextTransferHttp.download(base + "/slow", none, slow, r2);
        } catch (DenextTransferHttp.Stopped s) {
            stopped = true;
        }
        long kept = slow.length();
        check("a stopped download throws Stopped and keeps its partial file", stopped && kept > 0
            && kept < 524_288, "stopped=" + stopped + " kept=" + kept);
        check("the validator is kept beside it", DenextTransferHttp.metaFile(slow).isFile(), "no .meta");
        Recorder r3 = new Recorder(-1);
        DenextTransferHttp.Result resumed = DenextTransferHttp.download(base + "/slow", none, slow, r3);
        check("the resume asks for the rest (206)", resumed.status == 206, "status " + resumed.status);
        check("the resumed progress starts where it stopped", !r3.seen.isEmpty() && r3.seen.get(0)[0] == kept,
            r3.seen.isEmpty() ? "none" : "" + r3.seen.get(0)[0]);
        check("the resumed file is complete and in order", pattern(Files.readAllBytes(slow.toPath()), 524_288),
            slow.length() + " bytes");

        // 3. A server that ignores the range: the download starts over.
        File noRange = new File(work, "norange.bin.denext-part");
        try (FileOutputStream out = new FileOutputStream(noRange)) {
            out.write(new byte[] {9, 9, 9});
        }
        DenextTransferHttp.writeText(DenextTransferHttp.metaFile(noRange), "\"v1\"");
        DenextTransferHttp.Result fresh = DenextTransferHttp.download(base + "/norange", none, noRange, new Recorder(-1));
        check("a 200 to a range request starts over", fresh.status == 200
            && pattern(Files.readAllBytes(noRange.toPath()), 65_536), noRange.length() + " bytes");

        // 4. A partial file longer than the resource (416): dropped, downloaded again.
        File stale = new File(work, "stale.bin.denext-part");
        try (FileOutputStream out = new FileOutputStream(stale)) {
            out.write(new byte[600_000]);
        }
        DenextTransferHttp.writeText(DenextTransferHttp.metaFile(stale), "\"slow-v1\"");
        DenextTransferHttp.Result again = DenextTransferHttp.download(base + "/slow", none, stale, new Recorder(-1));
        check("a 416 drops the partial file and starts over", again.status == 200
            && pattern(Files.readAllBytes(stale.toPath()), 524_288), stale.length() + " bytes");

        // 5. A multipart upload.
        File photo = new File(work, "photo.jpg");
        byte[] bytes = new byte[100_000];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (i % 256);
        Files.write(photo.toPath(), bytes);
        Map<String, String> fields = new TreeMap<>();
        fields.put("album", "trip");
        fields.put("note", "a \"quoted\" one");
        Map<String, String> token = new HashMap<>();
        token.put("x-token", "t1");
        Recorder r4 = new Recorder(-1);
        DenextTransferHttp.Result up = DenextTransferHttp.upload(base + "/upload", "POST", token, photo,
            new DenextTransferHttp.Multipart("photo", "photo.jpg", "image/jpeg", fields), null, r4);
        check("the server read the file part and the fields", up.body.contains("\"photo\":100000")
            && up.body.contains("\"album\":\"trip\"") && up.body.contains("\"token\":\"t1\""), up.body);
        check("an upload reports its status and headers", up.status == 200 && "yes".equals(up.headers.get("x-echo")),
            up.status + " " + up.headers);
        check("an upload reports progress to the end", !r4.seen.isEmpty()
            && r4.seen.get(r4.seen.size() - 1)[0] == r4.seen.get(r4.seen.size() - 1)[1], "" + r4.seen.size());

        // 6. A binary upload.
        DenextTransferHttp.Result raw = DenextTransferHttp.upload(base + "/raw", "PUT", none, photo, null,
            "image/jpeg", new Recorder(-1));
        check("a binary upload sends the file as the body", "PUT image/jpeg 100000".equals(raw.body), raw.body);

        // 7. An HTTP error.
        try {
            DenextTransferHttp.download(base + "/missing", none, new File(work, "missing.part"), new Recorder(-1));
            check("a 404 throws HttpError with the status", false, "no error");
        } catch (DenextTransferHttp.HttpError e) {
            check("a 404 throws HttpError with the status", e.status == 404 && e.body.contains("not here"),
                e.status + " " + e.body);
        }

        // 8. The pieces.
        long[] range = DenextTransferHttp.contentRange("bytes 100-199/1000");
        check("Content-Range parses", range != null && range[0] == 100 && range[1] == 1000, "" + range);
        long[] open = DenextTransferHttp.contentRange("bytes 5-9/*");
        check("an unknown total is -1", open != null && open[1] == -1, "" + open);
        check("a malformed Content-Range is null", DenextTransferHttp.contentRange("items 1-2/3") == null, "");
        Map<String, String> kv = new HashMap<>();
        kv.put("k", "v");
        String head = new String(DenextTransferHttp.multipartHead("B",
            new DenextTransferHttp.Multipart("f", "a\"b.txt", "text/plain", kv)), StandardCharsets.UTF_8)
            + "hello" + new String(DenextTransferHttp.multipartTail("B"), StandardCharsets.UTF_8);
        String expected = "--B\r\nContent-Disposition: form-data; name=\"k\"\r\n\r\nv\r\n"
            + "--B\r\nContent-Disposition: form-data; name=\"f\"; filename=\"a%22b.txt\"\r\n"
            + "Content-Type: text/plain\r\n\r\nhello\r\n--B--\r\n";
        check("the multipart body is framed as RFC 7578 asks (as on iOS)", head.equals(expected), head);
        try {
            DenextTransferHttp.download("file:///etc/hosts", none, new File(work, "x"), new Recorder(-1));
            check("a non-http URL is refused", false, "no error");
        } catch (IOException e) {
            check("a non-http URL is refused", e.getMessage().contains("not an http(s) URL"), e.getMessage());
        }

        System.out.println("done " + failures);
        System.exit(failures == 0 ? 0 : 1);
    }
}
