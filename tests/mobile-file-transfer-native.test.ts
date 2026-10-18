// The native halves of denext's file transfers (`denext mobile add file-transfer`), run against a
// local HTTP server: the iOS manager (DenextTransferManager.swift) compiled for macOS and driven
// through Foundation's URLSession (downloads with progress, pause and resume from resume data,
// multipart and binary uploads, errors, cancel, saved records); the iOS plugin and manager
// type-checked against the iOS SDK and a Capacitor stub; and the Android HTTP half
// (DenextTransferHttp.java) compiled with javac and run (range resume, a server that ignores the
// range, 416, uploads). The Android worker and plugin compile in the native-plugins workflow
// (Gradle). Each case runs where its toolchain is: swiftc / the iOS SDK on macOS, a JDK
// (never skipped under CI, tests/_jdk.ts).

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  TRANSFER_ANDROID_FILES,
  TRANSFER_IOS_FILES,
} from "../src/build/transfer-native-templates.ts";
import { IGNORE_WITHOUT_JDK, requireJdk } from "./_jdk.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixture = (rel: string) => fromFileUrl(new URL(rel, FIXTURES));

/** `size` bytes where byte i is i % 251 (the harnesses check the order). */
function pattern(size: number, from = 0): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size - from);
  for (let i = from; i < size; i++) out[i - from] = i % 251;
  return out;
}

const SLOW_SIZE = 524_288;
const SLOW_ETAG = '"slow-v1"';
const MODIFIED = "Sat, 17 Oct 2026 00:00:00 GMT";

/** The slow resource from `start`, 8 KiB every 15 ms (so a transfer can be paused part-way). */
function slowBody(start: number): ReadableStream<Uint8Array<ArrayBuffer>> {
  let at = start;
  return new ReadableStream({
    async pull(controller) {
      if (at >= SLOW_SIZE) return controller.close();
      await new Promise((resolve) => setTimeout(resolve, 15));
      const end = Math.min(SLOW_SIZE, at + 8192);
      controller.enqueue(pattern(end, at));
      at = end;
    },
  });
}

/** `/slow`: ranges honoured while `If-Range` matches its ETag (or there is none). */
function slow(req: Request): Response {
  const range = /^bytes=(\d+)-$/.exec(req.headers.get("range") ?? "");
  const ifRange = req.headers.get("if-range");
  const base = {
    "accept-ranges": "bytes",
    etag: SLOW_ETAG,
    "last-modified": MODIFIED,
    "content-type": "application/octet-stream",
  };
  if (range && (!ifRange || ifRange === SLOW_ETAG || ifRange === MODIFIED)) {
    const start = Number(range[1]);
    if (start >= SLOW_SIZE) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${SLOW_SIZE}` },
      });
    }
    return new Response(slowBody(start), {
      status: 206,
      headers: {
        ...base,
        "content-length": String(SLOW_SIZE - start),
        "content-range": `bytes ${start}-${SLOW_SIZE - 1}/${SLOW_SIZE}`,
      },
    });
  }
  return new Response(slowBody(0), {
    headers: { ...base, "content-length": String(SLOW_SIZE) },
  });
}

/** `/upload`: the multipart body's file size and fields, and the `x-token` header, as JSON. */
async function upload(req: Request): Promise<Response> {
  const form = await req.formData();
  const out: Record<string, unknown> = { token: req.headers.get("x-token") };
  for (const [key, value] of form) {
    out[key] = typeof value === "string" ? value : value.size;
  }
  return Response.json(out, { headers: { "x-echo": "yes" } });
}

/** The server every harness runs against; `ranges` counts range requests to `/slow`. */
function serve(): { base: string; ranges: () => number; close: () => Promise<void> } {
  let ranges = 0;
  const big = pattern(1_048_576);
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/big") {
      return new Response(big.slice(), {
        headers: { "content-length": String(big.length), etag: '"big-v1"' },
      });
    }
    if (path === "/slow") {
      if (req.headers.has("range")) ranges++;
      return slow(req);
    }
    if (path === "/norange") {
      return new Response(pattern(65_536), {
        headers: { etag: '"v1"', "content-length": "65536" },
      });
    }
    if (path === "/upload") return await upload(req);
    if (path === "/raw") {
      const bytes = (await req.arrayBuffer()).byteLength;
      return new Response(`${req.method} ${req.headers.get("content-type")} ${bytes}`);
    }
    return new Response("not here", { status: 404 });
  });
  const { port } = server.addr as Deno.NetAddr;
  return { base: `http://127.0.0.1:${port}`, ranges: () => ranges, close: () => server.shutdown() };
}

function has(tool: string, args: string[]): boolean {
  try {
    return new Deno.Command(tool, { args, stdout: "null", stderr: "null" }).outputSync().success;
  } catch {
    return false;
  }
}

/** Run `cmd` to completion; a failure throws with its output. */
async function run(cmd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(`${cmd} failed:\n${text}`);
  return text;
}

/** A harness's output: no failures, and a clean tally. */
function assertHarness(output: string): void {
  const lines = output.trim().split("\n");
  assertEquals(lines.filter((l) => l.startsWith("FAIL")), [], output);
  assertEquals(lines.at(-1), "done 0", output);
}

/** Run a harness binary (it exits non-zero on a failed check, so read its output either way). */
async function runHarness(cmd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
  return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
}

const MAC_SWIFT = Deno.build.os === "darwin" && has("swiftc", ["--version"]);

Deno.test({
  name:
    "file transfer (iOS): the manager downloads, pauses, resumes and uploads (macOS URLSession)",
  ignore: !MAC_SWIFT,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_transfer_swift_" });
    const server = serve();
    try {
      await Deno.writeTextFile(
        join(dir, "DenextTransferManager.swift"),
        TRANSFER_IOS_FILES["DenextTransferManager.swift"],
      );
      await Deno.copyFile(fixture("file-transfer/TransferHarness.swift"), join(dir, "main.swift"));
      const bin = join(dir, "harness");
      await run("swiftc", [
        "-swift-version",
        "5",
        "-o",
        bin,
        join(dir, "main.swift"),
        join(dir, "DenextTransferManager.swift"),
      ]);
      const work = join(dir, "work");
      await Deno.mkdir(work);
      const out = await runHarness(bin, [server.base, work]);
      assertHarness(out);
      assert(out.includes("ok the resumed file is complete and in order"), out);
      assert(server.ranges() >= 1, "the resume sent no range request");
    } finally {
      await server.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

const IOS_SDK = Deno.build.os === "darwin" &&
  has("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]);

Deno.test({
  name:
    "file transfer (iOS): the plugin and the manager type-check against UIKit and a Capacitor stub",
  ignore: !IOS_SDK,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "denext_transfer_ios_" });
    try {
      const xcrun = (args: string[]) =>
        run("xcrun", ["--sdk", "iphoneos", "swiftc", "-target", "arm64-apple-ios15.0", ...args]);
      await Deno.copyFile(fixture("capacitor-ios/Capacitor.swift"), join(dir, "Capacitor.swift"));
      await xcrun([
        "-emit-module",
        "-parse-as-library",
        "-module-name",
        "Capacitor",
        "-emit-module-path",
        join(dir, "Capacitor.swiftmodule"),
        join(dir, "Capacitor.swift"),
      ]);
      for (const [name, text] of Object.entries(TRANSFER_IOS_FILES)) {
        await Deno.writeTextFile(join(dir, name), text);
      }
      for (const version of ["5", "6"]) {
        await xcrun([
          "-typecheck",
          "-swift-version",
          version,
          "-I",
          dir,
          ...Object.keys(TRANSFER_IOS_FILES).map((name) => join(dir, name)),
        ]);
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "file transfer (Android): the HTTP half compiles and resumes, restarts and uploads (javac)",
  ignore: IGNORE_WITHOUT_JDK,
  async fn() {
    requireJdk();
    const dir = await Deno.makeTempDir({ prefix: "denext_transfer_java_" });
    const server = serve();
    try {
      const pkg = join(dir, "src", "dev", "denext", "transfer");
      await Deno.mkdir(pkg, { recursive: true });
      await Deno.writeTextFile(
        join(pkg, "DenextTransferHttp.java"),
        TRANSFER_ANDROID_FILES["DenextTransferHttp.java"],
      );
      await Deno.copyFile(
        fixture("file-transfer/TransferHarness.java"),
        join(pkg, "TransferHarness.java"),
      );
      const classes = join(dir, "classes");
      await run("javac", [
        "-nowarn",
        "--release",
        "11",
        "-d",
        classes,
        join(pkg, "DenextTransferHttp.java"),
        join(pkg, "TransferHarness.java"),
      ]);
      const work = join(dir, "work");
      await Deno.mkdir(work);
      const out = await runHarness("java", [
        "-cp",
        classes,
        "dev.denext.transfer.TransferHarness",
        server.base,
        work,
      ]);
      assertHarness(out);
      assert(out.includes("ok the resume asks for the rest (206)"), out);
    } finally {
      await server.close();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
