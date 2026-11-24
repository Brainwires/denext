// Local IPC (src/desktop/local-ipc.ts): where a channel lives per OS (`localIpcPath`, pure, every
// shape through the `os` option: names, app ids, user tokens, the sun_path and pipe-name limits),
// the folder check, and REAL sockets: an echo through the web streams (binary, larger than one
// chunk, both directions at once), many sequential connections, `close()` ending open connections
// and removing the file, a stale socket replaced, a live one never stolen, connecting to nothing,
// the timeout and the abort, the 0600 mode and a refused world-writable folder, and the frames a
// Windows pipe connection writes and reads (a pipe has no half-close).
//
// The real-socket tests run on every OS: on Windows the path is a named pipe from `localIpcPath`
// (run this file on a Windows runner to exercise the pipe I/O), and the Unix-only checks (modes,
// folders, stale files) are skipped there.

import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import net from "node:net";
import {
  connectLocalIpc,
  connectLocalIpcWith,
  isLocalIpcPipePath,
  listenLocalIpc,
  type LocalIpcConnection,
  localIpcDirError,
  localIpcLockPath,
  localIpcNameError,
  localIpcPath,
  localIpcPermissionError,
  localIpcUserToken,
  pipeIdentityFrom,
  type PipeIdentityLookup,
  pipeServerRefusal,
  registerLocalIpcAppId,
  runtimePipeIdentity,
  type RuntimePipeServerIdentity,
} from "../src/desktop/local-ipc.ts";
import { osDataDir } from "../src/desktop/app-dirs.ts";

const WINDOWS = Deno.build.os === "windows";
const APP_ID = "dev.denext.localipctest";

// ---------------------------------------------------------------------------------------------
// localIpcPath (pure)
// ---------------------------------------------------------------------------------------------

Deno.test("localIpcPath: the Unix shapes are <dir>/<name>.sock", () => {
  assertEquals(localIpcPath("pty", { dir: "/tmp/a", os: "darwin" }), "/tmp/a/pty.sock");
  assertEquals(localIpcPath("pty-1.ctl", { dir: "/run/x/", os: "linux" }), "/run/x/pty-1.ctl.sock");
  // The default folder is the app's data folder + /ipc, for the given OS.
  assertEquals(
    localIpcPath("p", { appId: "com.acme.term", os: "darwin" }),
    `${osDataDir("com.acme.term", "darwin")}/ipc/p.sock`.replaceAll("\\", "/"),
  );
  assertEquals(
    localIpcPath("p", { appId: "com.acme.term", os: "linux" }),
    `${osDataDir("com.acme.term", "linux")}/ipc/p.sock`.replaceAll("\\", "/"),
  );
});

Deno.test("localIpcPath: the Windows shape is \\\\.\\pipe\\<appId>.<user>.<name>", () => {
  assertEquals(
    localIpcPath("pty", { appId: "com.acme.term", user: "u1", os: "windows" }),
    "\\\\.\\pipe\\com.acme.term.u1.pty",
  );
  // `dir` means nothing on Windows.
  assertEquals(
    localIpcPath("pty", { appId: "com.acme.term", user: "u1", dir: "/tmp", os: "windows" }),
    "\\\\.\\pipe\\com.acme.term.u1.pty",
  );
  // The default user token: a stable 12-hex-digit hash, never the raw name.
  const token = localIpcUserToken();
  assertMatch(token, /^[0-9a-f]{12}$/);
  assertEquals(localIpcUserToken(), token);
  assertEquals(
    localIpcPath("pty", { appId: "com.acme.term", os: "windows" }),
    `\\\\.\\pipe\\com.acme.term.${token}.pty`,
  );
});

Deno.test("localIpcUserToken: profile folder first, then the user name, different per user", () => {
  const alice = localIpcUserToken({ user: "alice" });
  const bob = localIpcUserToken({ user: "bob" });
  assert(alice !== bob);
  assert(!alice.includes("alice"));
  const profile = localIpcUserToken({ profile: "C:\\Users\\Alice", user: "bob" });
  assert(profile !== bob);
  // Case and slash spelling of the same profile folder give the same token.
  assertEquals(localIpcUserToken({ profile: "c:/users/alice" }), profile);
  // A blank profile falls back to the user name.
  assertEquals(localIpcUserToken({ profile: "  ", user: "bob" }), bob);
  assertEquals(localIpcUserToken({ profile: "  " }), localIpcUserToken({}));
});

Deno.test("localIpcPath: rejects every bad channel name", () => {
  const bad: unknown[] = [
    "",
    "-a",
    ".a",
    "_a",
    "a/b",
    "a\\b",
    "a b",
    "a:b",
    "a\0b",
    "é",
    "a".repeat(65),
    "../x",
    7,
    undefined,
  ];
  for (const name of bad) {
    assertThrows(
      () => localIpcPath(name as string, { dir: "/tmp", os: "linux" }),
      TypeError,
      "must be 1 to 64 of [A-Za-z0-9._-]",
      String(name),
    );
    assertEquals(typeof localIpcNameError(name), "string");
  }
  assertEquals(localIpcNameError("a".repeat(64)), null);
  assertEquals(localIpcNameError("9.x_y-z"), null);
});

Deno.test("localIpcPath: app id sanitized, required where the path needs it, registered default", () => {
  assertEquals(
    localIpcPath("p", { appId: "com.acme app/x", user: "u", os: "windows" }),
    "\\\\.\\pipe\\com.acme-app-x.u.p",
  );
  assertThrows(
    () => localIpcPath("p", { appId: "///", user: "u", os: "windows" }),
    TypeError,
    "no letter or digit",
  );
  registerLocalIpcAppId(undefined);
  assertThrows(() => localIpcPath("p", { user: "u", os: "windows" }), TypeError, "pass `appId`");
  assertThrows(() => localIpcPath("p", { os: "darwin" }), TypeError, "pass `appId`");
  // With a `dir`, Unix needs no app id.
  assertEquals(localIpcPath("p", { dir: "/tmp", os: "darwin" }), "/tmp/p.sock");
  registerLocalIpcAppId("com.acme.registered");
  try {
    assertEquals(
      localIpcPath("p", { user: "u", os: "windows" }),
      "\\\\.\\pipe\\com.acme.registered.u.p",
    );
    // An explicit appId wins over the registered one.
    assertEquals(
      localIpcPath("p", { appId: "x", user: "u", os: "windows" }),
      "\\\\.\\pipe\\x.u.p",
    );
  } finally {
    registerLocalIpcAppId(undefined);
  }
});

Deno.test("localIpcPath: a bad user token is refused", () => {
  for (const user of ["", "a b", "-x", "a\\b", "x".repeat(65)]) {
    assertThrows(
      () => localIpcPath("p", { appId: "a", user, os: "windows" }),
      TypeError,
      "user token",
      user,
    );
  }
});

Deno.test("localIpcPath: refuses a socket path past sun_path, counted in bytes", () => {
  // macOS: 104 bytes with the terminator, so 103 is the longest path.
  const mac = (len: number) => `/${"d".repeat(len - "/".length - "/p.sock".length)}`;
  assertEquals(localIpcPath("p", { dir: mac(103), os: "darwin" }).length, 103);
  assertThrows(
    () => localIpcPath("p", { dir: mac(104), os: "darwin" }),
    TypeError,
    "macOS allows 103 (sun_path is 104 bytes",
  );
  // Linux: 108, so 107.
  assertEquals(localIpcPath("p", { dir: mac(107), os: "linux" }).length, 107);
  assertThrows(
    () => localIpcPath("p", { dir: mac(108), os: "linux" }),
    TypeError,
    "pass a shorter dir",
  );
  // Bytes, not characters: 50 two-byte characters are 100 bytes.
  assertThrows(
    () => localIpcPath("p", { dir: `/${"é".repeat(50)}`, os: "darwin" }),
    TypeError,
    "108 bytes",
  );
  // A Windows pipe path is capped at 256 characters.
  assertThrows(
    () => localIpcPath("n".repeat(64), { appId: "a".repeat(200), user: "u", os: "windows" }),
    TypeError,
    "256-character limit",
  );
});

Deno.test("isLocalIpcPipePath: only \\\\.\\pipe\\ and \\\\?\\pipe\\ paths", () => {
  assert(isLocalIpcPipePath("\\\\.\\pipe\\a"));
  assert(isLocalIpcPipePath("\\\\?\\PIPE\\a"));
  assert(isLocalIpcPipePath("//./pipe/a"));
  assert(!isLocalIpcPipePath("/tmp/a.sock"));
  assert(!isLocalIpcPipePath("C:\\pipe\\a"));
  assert(!isLocalIpcPipePath("\\\\server\\share\\a"));
});

Deno.test("localIpcDirError: owner and group/other write, sticky exempt, unknowns skipped", () => {
  const dir = (mode: number | null, uid: number | null, isDirectory = true) => ({
    isDirectory,
    mode,
    uid,
  });
  assertEquals(localIpcDirError("/d", dir(0o40700, 501), 501), null);
  assertEquals(localIpcDirError("/d", dir(0o40755, 0), 501), null);
  assertEquals(localIpcDirError("/d", dir(0o41777, 0), 501), null);
  assertMatch(localIpcDirError("/d", dir(0o40700, 502), 501) ?? "", /owned by uid 502/);
  assertMatch(localIpcDirError("/d", dir(0o40777, 501), 501) ?? "", /mode 777/);
  assertMatch(localIpcDirError("/d", dir(0o40770, 501), 501) ?? "", /group or others/);
  assertMatch(localIpcDirError("/d", dir(0o100600, 501, false), 501) ?? "", /not a directory/);
  assertEquals(localIpcDirError("/d", dir(null, null), 501), null);
  assertEquals(localIpcDirError("/d", dir(0o40777, 501), null), null);
});

Deno.test("localIpcPermissionError: names the path, both grants and the packaged-app escape", () => {
  const err = localIpcPermissionError("/s/a.sock", "listen", new Error("x"));
  assert(err instanceof Deno.errors.NotCapable);
  for (
    const part of [
      "--allow-read=/s/a.sock",
      "--allow-write=/s/a.sock",
      "--allow-net-listen=unix:/s/a.sock",
      "--allow-net=unix:/s/a.sock",
      'netListen: ["*"]',
    ]
  ) assert(err.message.includes(part), part);
  assert(localIpcPermissionError("/s", "connect", null).message.includes('netConnect: ["*"]'));
});

// ---------------------------------------------------------------------------------------------
// Real sockets (named pipes on Windows)
// ---------------------------------------------------------------------------------------------

let seq = 0;

/** A fresh channel: a short temp dir on Unix (macOS's $TMPDIR is too long for sun_path). */
async function channel(): Promise<{ path: string; dir?: string; cleanup(): Promise<void> }> {
  const name = `t${Date.now().toString(36)}${(seq++).toString(36)}`;
  if (WINDOWS) {
    return { path: localIpcPath(name, { appId: APP_ID }), cleanup: async () => {} };
  }
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "dnipc" });
  return {
    path: localIpcPath(name, { dir }),
    dir,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

/** Every byte of `readable`. */
async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of readable) {
    parts.push(chunk);
    length += chunk.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Write `bytes` in `pieces` writes, then close. */
async function writeAll(writable: WritableStream<Uint8Array>, bytes: Uint8Array, pieces = 1) {
  const writer = writable.getWriter();
  const step = Math.ceil(bytes.length / pieces);
  for (let i = 0; i < bytes.length; i += step) await writer.write(bytes.subarray(i, i + step));
  await writer.close();
}

/** `n` pseudo-random bytes covering every value. */
function payload(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

const echo = (conn: LocalIpcConnection) => {
  conn.readable.pipeTo(conn.writable).catch(() => {});
};

Deno.test("local IPC: echo round trip of binary bytes larger than one chunk", async () => {
  const ch = await channel();
  try {
    await using server = await listenLocalIpc(ch.path, echo);
    assertEquals(server.path, ch.path);
    await using conn = await connectLocalIpc(ch.path);
    const sent = payload(3 * 1024 * 1024 + 17, 1);
    const [, got] = await Promise.all([writeAll(conn.writable, sent, 7), readAll(conn.readable)]);
    assertEquals(got.length, sent.length);
    assertEquals(got, sent);
  } finally {
    await ch.cleanup();
  }
});

Deno.test("local IPC: both directions at once, each side half-closing on its own", async () => {
  const ch = await channel();
  try {
    const fromClient = payload(1024 * 1024, 2);
    const fromServer = payload(1536 * 1024 + 3, 3);
    let serverGot: Promise<Uint8Array> | undefined;
    await using _server = await listenLocalIpc(ch.path, (conn) => {
      serverGot = Promise.all([readAll(conn.readable), writeAll(conn.writable, fromServer, 5)])
        .then(([got]) => got);
    });
    const conn = await connectLocalIpc(ch.path);
    const [clientGot] = await Promise.all([
      readAll(conn.readable),
      writeAll(conn.writable, fromClient, 3),
    ]);
    assertEquals(clientGot, fromServer);
    assert(serverGot);
    assertEquals(await serverGot, fromClient);
    await conn[Symbol.asyncDispose]();
  } finally {
    await ch.cleanup();
  }
});

Deno.test("local IPC: many sequential connections", async () => {
  const ch = await channel();
  try {
    let accepted = 0;
    await using _server = await listenLocalIpc(ch.path, (conn) => {
      accepted++;
      echo(conn);
    });
    for (let i = 0; i < 40; i++) {
      await using conn = await connectLocalIpc(ch.path);
      const bytes = new TextEncoder().encode(`hello ${i}`);
      const [, got] = await Promise.all([writeAll(conn.writable, bytes), readAll(conn.readable)]);
      assertEquals(new TextDecoder().decode(got), `hello ${i}`);
    }
    assertEquals(accepted, 40);
  } finally {
    await ch.cleanup();
  }
});

Deno.test("local IPC: close() ends open connections and removes the socket file", async () => {
  const ch = await channel();
  try {
    const server = await listenLocalIpc(ch.path, () => {});
    const conn = await connectLocalIpc(ch.path);
    const reading = readAll(conn.readable).then(() => "ended", () => "errored");
    await server.close();
    // Ended or errored, but done: the server destroyed its side.
    assert(["ended", "errored"].includes(await reading));
    await server.close(); // idempotent
    if (!WINDOWS) {
      await assertRejects(() => Deno.lstat(ch.path), Deno.errors.NotFound);
    }
    await assertRejects(() => connectLocalIpc(ch.path));
    conn.close();
  } finally {
    await ch.cleanup();
  }
});

Deno.test("local IPC: a throwing onConnection closes that connection only", async () => {
  const ch = await channel();
  try {
    let n = 0;
    await using _server = await listenLocalIpc(ch.path, (conn) => {
      if (n++ === 0) throw new Error("boom");
      echo(conn);
    });
    const first = await connectLocalIpc(ch.path);
    assertEquals((await readAll(first.readable).catch(() => new Uint8Array())).length, 0);
    first.close();
    await using second = await connectLocalIpc(ch.path);
    const [, got] = await Promise.all([
      writeAll(second.writable, new Uint8Array([1, 2, 3])),
      readAll(second.readable),
    ]);
    assertEquals(got, new Uint8Array([1, 2, 3]));
  } finally {
    await ch.cleanup();
  }
});

Deno.test("local IPC: a live server's socket is never taken over", async () => {
  const ch = await channel();
  try {
    await using _server = await listenLocalIpc(ch.path, echo);
    await assertRejects(
      () => listenLocalIpc(ch.path, () => {}),
      Deno.errors.AddrInUse,
      "another server listens",
    );
    // The first server still answers.
    await using conn = await connectLocalIpc(ch.path);
    const [, got] = await Promise.all([
      writeAll(conn.writable, new Uint8Array([9])),
      readAll(conn.readable),
    ]);
    assertEquals(got, new Uint8Array([9]));
  } finally {
    await ch.cleanup();
  }
});

Deno.test({
  name:
    "local IPC: two servers starting at once on one path: exactly one serves; a held lock is never broken",
  ignore: WINDOWS, // a pipe name is claimed by its first instance; this is the Unix socket's lock
  fn: async () => {
    const ch = await channel();
    try {
      // Both start together: one binds, the other is refused, and nothing removes the winner's
      // socket (the stale check, the bind and the removal at close are under the server's lock).
      const results = await Promise.allSettled([
        listenLocalIpc(ch.path, echo),
        listenLocalIpc(ch.path, echo),
      ]);
      const served = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      assertEquals([served.length, refused.length], [1, 1]);
      assert(refused[0].reason instanceof Deno.errors.AddrInUse, String(refused[0].reason));
      const server =
        (served[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof listenLocalIpc>>>)
          .value;
      {
        await using conn = await connectLocalIpc(ch.path);
        const [, got] = await Promise.all([
          writeAll(conn.writable, new Uint8Array([4])),
          readAll(conn.readable),
        ]);
        assertEquals(got, new Uint8Array([4]));
      }
      await server.close();
      // Closed: the lock is free again, and the next server takes the path.
      await (await listenLocalIpc(ch.path, echo)).close();
      // Held by another process (with no socket at the path at all): refused, never broken.
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          `const f = Deno.openSync(${
            JSON.stringify(localIpcLockPath(ch.path))
          }, { write: true, create: true });
f.lockSync(true);
console.log("locked");
setTimeout(() => {}, 60_000);`,
        ],
        stdout: "piped",
        stderr: "null",
      }).spawn();
      const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
      try {
        let seen = "";
        while (!seen.includes("locked")) {
          const { value, done } = await reader.read();
          assert(!done, "the locking process ended early");
          seen += value;
        }
        await assertRejects(() => listenLocalIpc(ch.path, echo), Deno.errors.AddrInUse);
      } finally {
        child.kill("SIGKILL");
        await child.status;
        await reader.cancel().catch(() => {});
      }
      // Its holder is gone: the OS freed the lock.
      await (await listenLocalIpc(ch.path, echo)).close();
    } finally {
      await ch.cleanup();
    }
  },
});

Deno.test("local IPC: connecting to nothing rejects clearly", async () => {
  const ch = await channel();
  try {
    const err = await assertRejects(() => connectLocalIpc(ch.path));
    assert(
      err instanceof Deno.errors.NotFound || err instanceof Deno.errors.ConnectionRefused,
      String(err),
    );
    assertMatch((err as Error).message, /nothing listens on/);
  } finally {
    await ch.cleanup();
  }
});

Deno.test("local IPC: connect times out, and aborts", async () => {
  // A socket that never connects reaches the timeout and the abort deterministically.
  const neverConnects = () => new net.Socket();
  await assertRejects(
    () => connectLocalIpcWith(neverConnects, "/x.sock", { timeoutMs: 20 }),
    Deno.errors.TimedOut,
    "took over 20 ms",
  );
  const ac = new AbortController();
  const pending = connectLocalIpcWith(neverConnects, "/x.sock", { signal: ac.signal });
  ac.abort(new Error("gave up"));
  await assertRejects(() => pending, Error, "gave up");
  // An already-aborted signal rejects at once.
  await assertRejects(() => connectLocalIpc("/x.sock", { signal: AbortSignal.abort() }));
  // A socket factory that throws rejects with its error.
  await assertRejects(
    () =>
      connectLocalIpcWith(() => {
        throw new Error("no socket");
      }, "/x.sock"),
    Error,
    "no socket",
  );
});

Deno.test("local IPC: listen honours an AbortSignal", async () => {
  const ch = await channel();
  try {
    await assertRejects(() => listenLocalIpc(ch.path, () => {}, { signal: AbortSignal.abort() }));
    const ac = new AbortController();
    await listenLocalIpc(ch.path, () => {}, { signal: ac.signal });
    ac.abort();
    // The server closes: the path is free again.
    let relisten;
    for (let i = 0; i < 50 && !relisten; i++) {
      relisten = await listenLocalIpc(ch.path, () => {}).catch(() => undefined);
      if (!relisten) await new Promise((r) => setTimeout(r, 20));
    }
    assert(relisten);
    await relisten.close();
  } finally {
    await ch.cleanup();
  }
});

Deno.test({
  name: "local IPC: the socket is 0600, a stale socket is replaced, a non-socket refused (Unix)",
  ignore: WINDOWS,
  fn: async () => {
    const ch = await channel();
    try {
      // A stale socket file: bound, renamed away from the path its listener unlinks on close.
      const bound = join(ch.dir!, "bound.sock");
      const listener = Deno.listen({ transport: "unix", path: bound });
      await Deno.rename(bound, ch.path);
      listener.close();
      assert((await Deno.lstat(ch.path)).isSocket);
      await using server = await listenLocalIpc(ch.path, echo);
      assertEquals((await Deno.stat(ch.path)).mode! & 0o777, 0o600);
      await using conn = await connectLocalIpc(ch.path);
      const [, got] = await Promise.all([
        writeAll(conn.writable, new Uint8Array([4, 2])),
        readAll(conn.readable),
      ]);
      assertEquals(got, new Uint8Array([4, 2]));
      await server.close();
      // A regular file at the path is never removed.
      await Deno.writeTextFile(ch.path, "keep");
      await assertRejects(
        () => listenLocalIpc(ch.path, () => {}),
        Deno.errors.AlreadyExists,
        "is not a socket",
      );
      assertEquals(await Deno.readTextFile(ch.path), "keep");
    } finally {
      await ch.cleanup();
    }
  },
});

Deno.test({
  name: "local IPC: the folder is created 0700, a world-writable one refused (Unix)",
  ignore: WINDOWS,
  fn: async () => {
    const ch = await channel();
    try {
      const fresh = join(ch.dir!, "a", "ipc");
      await using _server = await listenLocalIpc(localIpcPath("x", { dir: fresh }), () => {});
      assertEquals((await Deno.stat(fresh)).mode! & 0o777, 0o700);
      const open = join(ch.dir!, "open");
      await Deno.mkdir(open);
      await Deno.chmod(open, 0o777);
      await assertRejects(
        () => listenLocalIpc(localIpcPath("x", { dir: open }), () => {}),
        Deno.errors.PermissionDenied,
        "writable by its group or others",
      );
      await assertRejects(() => Deno.lstat(join(open, "x.sock")), Deno.errors.NotFound);
    } finally {
      await ch.cleanup();
    }
  },
});

Deno.test("local IPC: a refused permission names the grants (child process)", async () => {
  const ch = await channel();
  try {
    const script = `
      import { listenLocalIpc, connectLocalIpc } from ${
      JSON.stringify(new URL("../src/desktop/local-ipc.ts", import.meta.url).href)
    };
      const out = [];
      for (const f of [() => listenLocalIpc(Deno.args[0], () => {}), () => connectLocalIpc(Deno.args[0])]) {
        try { await f(); out.push("ok"); } catch (e) { out.push(e.name + ": " + e.message); }
      }
      console.log(JSON.stringify(out));
    `;
    const file = await Deno.makeTempFile({ suffix: ".ts" });
    try {
      await Deno.writeTextFile(file, script);
      const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-lock",
          `--config=${new URL("../deno.json", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")}`,
          "--allow-read",
          "--allow-write",
          "--allow-env",
          file,
          ch.path,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(code, 0, new TextDecoder().decode(stderr));
      const [listen, connect] = JSON.parse(new TextDecoder().decode(stdout)) as string[];
      assertMatch(listen, /^NotCapable: local IPC: listen on .* --allow-net-listen=unix:/);
      assertMatch(connect, /^NotCapable: local IPC: connect on .* --allow-net-connect=unix:/);
    } finally {
      await Deno.remove(file);
    }
  } finally {
    await ch.cleanup();
  }
});

/** A little-endian u32 frame header for `n` payload bytes. */
function header(n: number): Uint8Array {
  const h = new Uint8Array(4);
  new DataView(h.buffer).setUint32(0, n, true);
  return h;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// A Windows pipe has no half-close, so a pipe channel frames its bytes. The framing is driven here
// on every OS: the connection is made for a pipe path while the bytes travel over this OS's real
// channel, with a raw `node:net` peer reading and writing the frames.
Deno.test("local IPC: a pipe connection frames each write and ends with a zero-length frame", async () => {
  const ch = await channel();
  try {
    let peer: net.Socket | undefined;
    const raw: Uint8Array[] = [];
    const peerEnded = Promise.withResolvers<void>();
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      peer = s;
      s.on("data", (c: Uint8Array) => raw.push(new Uint8Array(c)));
      s.once("end", () => peerEnded.resolve());
    });
    await new Promise<void>((resolve) => server.listen(ch.path, () => resolve()));
    try {
      const conn = await connectLocalIpcWith(
        () => net.connect({ path: ch.path, allowHalfOpen: true }),
        "\\\\.\\pipe\\dev.denext.framing.u.t",
      );
      // Writes: a small one, an empty one (sends nothing), one past the 1 MiB frame limit.
      const big = payload(1024 * 1024 + 5, 9);
      const writer = conn.writable.getWriter();
      await writer.write(new Uint8Array([1, 2, 3]));
      await writer.write(new Uint8Array(0));
      await writer.write(big);
      await writer.close();
      // The peer answers in frames split at awkward places, then ends; the client's readable
      // yields the payloads and closes, and the pipe closes once both directions are done.
      const reply = concat([header(2), new Uint8Array([7, 8]), header(1), new Uint8Array([9])]);
      const read = readAll(conn.readable);
      assert(peer);
      // Inside the first header, inside the first payload, at a header boundary, then the rest.
      for (const [from, to] of [[0, 1], [1, 5], [5, 6], [6, reply.length]]) {
        peer.write(reply.subarray(from, to));
        await new Promise((r) => setTimeout(r, 5));
      }
      peer.write(header(0));
      assertEquals(await read, new Uint8Array([7, 8, 9]));
      await peerEnded.promise;
      assertEquals(
        concat(raw),
        concat([
          header(3),
          new Uint8Array([1, 2, 3]),
          header(1024 * 1024),
          big.subarray(0, 1024 * 1024),
          header(5),
          big.subarray(1024 * 1024),
          header(0),
        ]),
      );
    } finally {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await ch.cleanup();
  }
});

Deno.test("local IPC: a pipe frame claiming more than the frame limit errors the read and closes", async () => {
  const ch = await channel();
  try {
    let peer: net.Socket | undefined;
    const peerClosed = Promise.withResolvers<void>();
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      peer = s;
      s.on("error", () => {});
      s.on("data", () => {}); // flowing, so the client's close reaches it as `end`
      s.once("end", () => peerClosed.resolve());
    });
    await new Promise<void>((resolve) => server.listen(ch.path, () => resolve()));
    try {
      const conn = await connectLocalIpcWith(
        () => net.connect({ path: ch.path, allowHalfOpen: true }),
        "\\\\.\\pipe\\dev.denext.framing.u.t",
      );
      const read = readAll(conn.readable);
      assert(peer);
      // A header naming 4 GiB - 1, then a few bytes: refused at the header, nothing buffered.
      peer.write(concat([header(0xffff_ffff), new Uint8Array([1, 2, 3])]));
      // (Bounded, so a decoder that waits for the 4 GiB instead fails here rather than hangs.)
      let bound: ReturnType<typeof setTimeout> | undefined;
      const err = await assertRejects(() =>
        Promise.race([
          read,
          new Promise((_, reject) =>
            bound = setTimeout(() => reject(new Error("still reading")), 10_000)
          ),
        ]).finally(() => clearTimeout(bound))
      );
      assert(err instanceof Deno.errors.InvalidData, String(err));
      assertMatch(err.message, /exceeds the 1048576-byte limit/);
      await peerClosed.promise; // the connection was closed
    } finally {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await ch.cleanup();
  }
});

Deno.test("pipeServerRefusal: only a pipe this user's process serves is taken", () => {
  const path = "\\\\.\\pipe\\dev.denext.app.u.chan";
  const me = "S-1-5-21-1-2-3-1001";
  assertEquals(pipeServerRefusal({ userSid: me, pid: 7 }, me, path), null);
  assertEquals(pipeServerRefusal({ userSid: me.toLowerCase() }, me, path), null);
  assertMatch(
    pipeServerRefusal({ userSid: "S-1-5-21-1-2-3-1002", pid: 9 }, me, path) ?? "",
    /served by another user \(S-1-5-21-1-2-3-1002, process 9\)/,
  );
  assertMatch(pipeServerRefusal(null, me, path) ?? "", /could not verify who serves/);
  assertMatch(pipeServerRefusal({ userSid: me }, null, path) ?? "", /could not verify/);
});

// The client's check of a pipe's server, driven on every OS: the connection is made for a pipe
// path over this OS's real channel, with who serves it answered by an injected lookup.
Deno.test("local IPC: a pipe served by another user (or one nobody can vouch for) is refused", async () => {
  const ch = await channel();
  try {
    const peers: net.Socket[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      peers.push(s);
      s.on("error", () => {});
      s.on("data", () => {});
    });
    await new Promise<void>((resolve) => server.listen(ch.path, () => resolve()));
    const pipe = "\\\\.\\pipe\\dev.denext.squat.u.t";
    const open = () => net.connect({ path: ch.path, allowHalfOpen: true });
    const lookup = (sid: string | null, ownSid = "S-1-5-21-9-9-9-1001"): PipeIdentityLookup => ({
      server: () => Promise.resolve(sid === null ? null : { userSid: sid, pid: 4242 }),
      currentUserSid: () => Promise.resolve(ownSid),
    });
    try {
      // Another user's process created the name first: refused, the connection closed.
      const other = await assertRejects(
        () => connectLocalIpcWith(open, pipe, {}, lookup("S-1-5-21-9-9-9-1002")),
        Deno.errors.PermissionDenied,
      );
      assertMatch(other.message, /served by another user/);
      // A lookup that cannot tell: refused too.
      await assertRejects(
        () => connectLocalIpcWith(open, pipe, {}, lookup(null)),
        Deno.errors.PermissionDenied,
        "could not verify",
      );
      // A failing lookup: refused, never an unhandled error.
      const failing: PipeIdentityLookup = {
        server: () => Promise.reject(new Error("token unreadable")),
        currentUserSid: () => Promise.resolve("S-1-5-21-9-9-9-1001"),
      };
      await assertRejects(
        () => connectLocalIpcWith(open, pipe, {}, failing),
        Deno.errors.PermissionDenied,
      );
      // This user's own server: connected.
      const conn = await connectLocalIpcWith(open, pipe, {}, lookup("S-1-5-21-9-9-9-1001"));
      conn.close();
      // A Unix socket path is never asked (its folder's ownership guards it).
      const unix = await connectLocalIpcWith(open, ch.path, {}, lookup("S-1-5-21-9-9-9-1002"));
      unix.close();
    } finally {
      for (const p of peers) p.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await ch.cleanup();
  }
});

// The runtime's lookup, over an injected `Deno.pipeServerIdentity`-shaped function: the connection
// is made for a pipe path over this OS's real channel.
Deno.test("local IPC: the runtime's pipe server identity decides which pipe a client takes", async () => {
  const ch = await channel();
  try {
    const peers: net.Socket[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      peers.push(s);
      s.on("error", () => {});
      s.on("data", () => {});
    });
    await new Promise<void>((resolve) => server.listen(ch.path, () => resolve()));
    const pipe = "\\\\.\\pipe\\dev.denext.ident.u.t";
    const open = () => net.connect({ path: ch.path, allowHalfOpen: true });
    const me = "S-1-5-21-9-9-9-1001";
    const other = "S-1-5-21-9-9-9-1002";
    let reads = 0;
    let handed: object | undefined;
    const connect = (answer: Partial<RuntimePipeServerIdentity> | null | Error) => {
      const runtime = {
        pipeServerIdentity(connection: object): RuntimePipeServerIdentity | null {
          reads++;
          handed = connection;
          if (answer instanceof Error) throw answer;
          if (answer === null) return null;
          return { pid: 4242, userSid: me, ownerSid: me, currentUserSid: me, ...answer };
        },
      };
      return connectLocalIpcWith(open, pipe, {}, runtimePipeIdentity(runtime));
    };
    const refused = (answer: Partial<RuntimePipeServerIdentity> | null | Error, text: RegExp) =>
      assertRejects(() => connect(answer), Deno.errors.PermissionDenied).then((err) =>
        assertMatch(err.message, text)
      );
    try {
      // This user's server on this user's pipe: taken, the runtime asked once, with the socket.
      const own = await connect({});
      assertEquals(reads, 1);
      assert(handed instanceof net.Socket);
      own.close();
      (await connect({ userSid: me.toLowerCase(), ownerSid: me.toUpperCase() })).close();
      // Another user's server: refused, named with its process.
      await refused(
        { userSid: other, ownerSid: other },
        /served by another user \(S-1-5-21-9-9-9-1002, process 4242\)/,
      );
      // The pipe's owner is not the server's user: the owner counts.
      await refused(
        { userSid: me, ownerSid: other },
        /served by another user \(S-1-5-21-9-9-9-1002/,
      );
      // Our pipe served by another user's process: refused too (both must be this user).
      await refused(
        { userSid: other, ownerSid: me },
        /served by another user \(S-1-5-21-9-9-9-1002/,
      );
      // No answer, or a field the runtime could not read: refused.
      await refused(null, /could not verify/);
      await refused({ userSid: null }, /could not verify/);
      await refused({ ownerSid: null }, /could not verify/);
      await refused({ currentUserSid: null }, /could not verify/);
      await refused(new Error("handle closed"), /could not verify/);
    } finally {
      for (const p of peers) p.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await ch.cleanup();
  }
});

Deno.test("pipeIdentityFrom: one read serves both answers; a server and owner that differ name the one that is not this user", async () => {
  const socket = new net.Socket();
  try {
    let reads = 0;
    const lookup = pipeIdentityFrom(() => {
      reads++;
      return {
        pid: 7,
        userSid: "S-1-5-18",
        ownerSid: "S-1-5-21-1-2-3-1001",
        currentUserSid: "S-1-5-21-1-2-3-1001",
      };
    });
    assertEquals(await lookup.server(socket), { userSid: "S-1-5-18", pid: 7 });
    assertEquals(await lookup.currentUserSid(socket), "S-1-5-21-1-2-3-1001");
    assertEquals(reads, 1);
    const none = pipeIdentityFrom(() => null);
    assertEquals(await none.server(socket), null);
    assertEquals(await none.currentUserSid(socket), null);
  } finally {
    socket.destroy();
  }
});

Deno.test("runtimePipeIdentity: a runtime without Deno.pipeServerIdentity has no lookup, so the check is skipped", async () => {
  assertEquals(runtimePipeIdentity({}), undefined);
  assertEquals(runtimePipeIdentity({ pipeServerIdentity: "3.0.0" }), undefined);
  assert(runtimePipeIdentity({ pipeServerIdentity: () => null }) !== undefined);
  // The default follows the running runtime's own function.
  const has = typeof (Deno as { pipeServerIdentity?: unknown }).pipeServerIdentity === "function";
  assertEquals(runtimePipeIdentity() !== undefined, has);
  // With no lookup a pipe path connects unchecked.
  const ch = await channel();
  try {
    const peers: net.Socket[] = [];
    const server = net.createServer({ allowHalfOpen: true }, (s) => {
      peers.push(s);
      s.on("error", () => {});
      s.on("data", () => {});
    });
    await new Promise<void>((resolve) => server.listen(ch.path, () => resolve()));
    try {
      const conn = await connectLocalIpcWith(
        () => net.connect({ path: ch.path, allowHalfOpen: true }),
        "\\\\.\\pipe\\dev.denext.nolookup.u.t",
        {},
        runtimePipeIdentity({}),
      );
      conn.close();
    } finally {
      for (const p of peers) p.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    await ch.cleanup();
  }
});
