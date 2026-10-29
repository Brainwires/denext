// A pinned download (src/build/deno-toolchain.ts `downloadPinned`) that hangs is given up on: no
// response headers within the connect deadline, or no body bytes for the idle deadline, and is
// retried on a new connection a few times (src/build/verified-download.ts `withDownloadRetries`).
// The deadlines come from the environment, so this file runs serially.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DenoToolchainDownloadError, downloadPinned } from "../src/build/deno-toolchain.ts";
import {
  DownloadConnectError,
  downloadDeadlines,
  DownloadNetworkError,
  DownloadStatusError,
  freshHttpClient,
  retryWaitMs,
  withDownloadRetries,
} from "../src/build/verified-download.ts";
import { standIn } from "./helpers/download-stand-in.ts";

const NAMES = {
  artifact: { file: "deno.zip", url: "https://toolchain.test/deno.zip", sha256: "0".repeat(64) },
  what: "Deno toolchain",
};

/** Run `fn` with the two deadlines set to 200 ms, restoring the environment after. */
async function withShortDeadlines(fn: (dest: string) => Promise<void>): Promise<void> {
  const keys = ["DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS", "DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS"];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of keys) Deno.env.set(k, "200");
  const dir = await Deno.makeTempDir({ prefix: "denext_dl_timeout_" });
  try {
    await fn(join(dir, "deno.zip"));
    assertEquals([...Deno.readDirSync(dir)], [], "nothing is left behind");
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("downloadPinned: a server that never answers is given up on at the connect deadline", async () => {
  await withShortDeadlines(async (dest) => {
    // No response headers, ever (a half-open connection): only the abort ends it.
    const silent: typeof fetch = (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      );
    const err = await assertRejects(
      () => downloadPinned(NAMES, dest, silent, () => {}),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(err.message, "no response within 0.2 s");
    assertStringIncludes(err.message, "DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS");
  });
});

Deno.test("downloadPinned: a body that stops sending is given up on at the idle deadline", async () => {
  await withShortDeadlines(async (dest) => {
    // Headers and a first chunk, then nothing.
    const stalls: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array([1, 2, 3]));
            },
          }),
        ),
      );
    const err = await assertRejects(
      () => downloadPinned(NAMES, dest, stalls, () => {}),
      DenoToolchainDownloadError,
    );
    assertStringIncludes(err.message, "no data for 0.2 s");
    assertStringIncludes(err.message, "DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS");
  });
});

// ---------------------------------------------------------------------------------------------
// Retries: a stalled connection is given up on quickly and the download retried on a NEW one
// (a fresh HTTP client per attempt), within an attempt count and an overall budget.

/** Run `fn` with the download variables set to `vars`, restoring the environment after. */
async function withVars(
  vars: Record<string, string>,
  fn: (dest: string) => Promise<void>,
): Promise<void> {
  const keys = [
    "DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS",
    "DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS",
    "DENEXT_DOWNLOAD_ATTEMPTS",
    "DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS",
  ];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of keys) Deno.env.delete(k);
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
  const dir = await Deno.makeTempDir({ prefix: "denext_dl_retry_" });
  try {
    await fn(join(dir, "deno.zip"));
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(dir, { recursive: true });
  }
}

/** The pinned artifact the stand-in serves. */
async function pinFor(url: string, body: Uint8Array) {
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource));
  return {
    artifact: {
      file: "deno.zip",
      url,
      sha256: [...sha].map((b) => b.toString(16).padStart(2, "0")).join(""),
      size: body.byteLength,
    },
    what: "Deno toolchain",
  };
}

const BODY = new TextEncoder().encode("the pinned toolchain bytes");

Deno.test("downloadPinned: a connection that goes silent is retried on a new one, which answers", async () => {
  for (const first of ["silent", "stall-mid-body"] as const) {
    const server = standIn(BODY, (n) => n === 0 ? first : "answer");
    try {
      await withVars({
        DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS: "300",
        DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS: "300",
      }, async (dest) => {
        const lines: string[] = [];
        await downloadPinned(await pinFor(server.url, BODY), dest, fetch, (l) => lines.push(l));
        assertEquals(await Deno.readFile(dest), BODY, first);
        assertEquals(server.connections(), 2, `${first}: the retry used a new connection`);
        assertEquals(lines.length, 1, first);
        assertStringIncludes(lines[0], "retrying on a new connection (attempt 2 of 4)");
        assertStringIncludes(
          lines[0],
          first === "silent" ? "no response within 0.3 s" : "no data for 0.3 s",
        );
      });
    } finally {
      await server.close();
    }
  }
});

Deno.test("downloadPinned: a server that stalls forever fails with a report of every attempt", async () => {
  const server = standIn(BODY, () => "silent");
  try {
    await withVars({
      DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS: "200",
      DENEXT_DOWNLOAD_ATTEMPTS: "3",
    }, async (dest) => {
      const pin = await pinFor(server.url, BODY);
      const err = await assertRejects(
        () => downloadPinned(pin, dest, fetch, () => {}),
        DenoToolchainDownloadError,
      );
      assertStringIncludes(err.message, "(3 attempts, each on a new connection):");
      for (const n of [1, 2, 3]) {
        assertStringIncludes(
          err.message,
          `attempt ${n}: no response within 0.2 s (DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS)`,
        );
      }
      assertStringIncludes(err.message, "DENEXT_DOWNLOAD_ATTEMPTS");
      assertEquals(server.connections(), 3);
      assertEquals(await Deno.stat(dest).catch(() => null), null, "no partial file is kept");
    });
  } finally {
    await server.close();
  }
});

Deno.test("downloadPinned: a slow but steady download is never cut off, by the idle deadline or the overall budget", async () => {
  // The first connection stalls; the retry sends a byte every 40 ms: far longer in all than the
  // idle deadline and the overall budget, never a gap as long as the idle deadline.
  const server = standIn(BODY, (n) => n === 0 ? "silent" : { slow: 40 });
  try {
    await withVars({
      DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS: "200",
      DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS: "400",
      DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS: "600",
    }, async (dest) => {
      const started = Date.now();
      await downloadPinned(await pinFor(server.url, BODY), dest, fetch, () => {});
      assertEquals(await Deno.readFile(dest), BODY);
      assertEquals(server.connections(), 2);
      assert(Date.now() - started > 1_000, "the transfer outlasted the idle and total budgets");
    });
  } finally {
    await server.close();
  }
});

Deno.test("downloadDeadlines: the defaults, 0 for none, and a bad value keeps the default", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(downloadDeadlines(env({})), {
    connectMs: 10_000,
    idleMs: 20_000,
    attempts: 4,
    totalMs: 120_000,
  });
  assertEquals(
    downloadDeadlines(env({
      DENEXT_DOWNLOAD_CONNECT_TIMEOUT_MS: "0",
      DENEXT_DOWNLOAD_IDLE_TIMEOUT_MS: " 1500 ",
      DENEXT_DOWNLOAD_ATTEMPTS: "0",
      DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS: "soon",
    })),
    { connectMs: Infinity, idleMs: 1_500, attempts: 4, totalMs: 120_000 },
  );
  assertEquals(downloadDeadlines(env({ DENEXT_DOWNLOAD_ATTEMPTS: "7" })).attempts, 7);
  assertEquals(downloadDeadlines(env({ DENEXT_DOWNLOAD_ATTEMPTS: "100000" })).attempts, 100);
});

Deno.test("retryWaitMs: exponential from 250 ms, capped at 4 s, half of it jittered", () => {
  assertEquals(retryWaitMs(1, () => 0), 125);
  assertEquals(retryWaitMs(1, () => 0.999999), 250);
  assertEquals(retryWaitMs(2, () => 0), 250);
  assertEquals(retryWaitMs(3, () => 0.5), 750);
  assertEquals(retryWaitMs(10, () => 0), 2_000);
  assertEquals(retryWaitMs(40, () => 0.999999), 4_000);
});

/** Fixed deadlines for the seam tests. */
const DEADLINES = { connectMs: 1_000, idleMs: 1_000, attempts: 4, totalMs: 60_000 };

Deno.test("withDownloadRetries: what is not worth a retry is thrown at once, the attempt's own error", async () => {
  for (
    const err of [
      new Error("SHA-256 mismatch"),
      new Error("wrapped 404", { cause: new DownloadStatusError("https://x.test/a", 404, "") }),
    ]
  ) {
    let calls = 0;
    const got = await assertRejects(() =>
      withDownloadRetries(
        "x",
        () => {
          calls++;
          return Promise.reject(err);
        },
        fetch,
        () => new Error("report"),
        { deadlines: DEADLINES, httpClient: () => null },
      )
    );
    assertEquals(got, err);
    assertEquals(calls, 1);
  }
});

Deno.test("withDownloadRetries: a 503 is retried; each attempt gets a new client, closed after it", async () => {
  const closed: number[] = [];
  let made = 0;
  const client = () => {
    const id = ++made;
    return { close: () => closed.push(id) } as unknown as Deno.HttpClient;
  };
  const seen: unknown[] = [];
  const fetchImpl = ((_url: string, init?: RequestInit & { client?: unknown }) => {
    seen.push(init?.client);
    return Promise.resolve(new Response("x"));
  }) as typeof fetch;
  const waits: number[] = [];
  const got = await withDownloadRetries(
    "x",
    async ({ fetch: f, number }) => {
      await f("https://x.test/a");
      if (number < 3) {
        throw new Error("down", { cause: new DownloadStatusError("https://x.test/a", 503, "") });
      }
      return "done";
    },
    fetchImpl,
    () => new Error("report"),
    {
      deadlines: DEADLINES,
      httpClient: client,
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
      random: () => 0,
    },
  );
  assertEquals(got, "done");
  assertEquals(made, 3);
  assertEquals(closed, [1, 2, 3]);
  assertEquals(new Set(seen).size, 3, "a different client each attempt");
  assertEquals(waits, [125, 250]);
});

Deno.test("withDownloadRetries: the overall budget stops new attempts and says so; one attempt's error is its own", async () => {
  let t = 0;
  const stall = () => Promise.reject(new DownloadConnectError(10_000));
  const err = await assertRejects(() =>
    withDownloadRetries(
      "x",
      () => {
        t += 10_000;
        return stall();
      },
      fetch,
      (report) => new Error(`failed${report}`),
      {
        deadlines: { ...DEADLINES, attempts: 10, totalMs: 25_000 },
        httpClient: () => null,
        now: () => t,
        sleep: () => Promise.resolve(),
        random: () => 0,
      },
    ), Error);
  assertStringIncludes(err.message, "failed (3 attempts):");
  assertStringIncludes(err.message, "attempt 3: no response within 10 s");
  assertStringIncludes(
    err.message,
    "no more attempts after 25 s (DENEXT_DOWNLOAD_TOTAL_TIMEOUT_MS)",
  );
  const one = new DownloadNetworkError("connection reset");
  const only = await assertRejects(() =>
    withDownloadRetries("x", () => Promise.reject(one), fetch, () => new Error("report"), {
      deadlines: { ...DEADLINES, attempts: 1 },
      httpClient: () => null,
    })
  );
  assertEquals(only, one);
});

Deno.test("freshHttpClient: this runtime has Deno.createHttpClient, and the client closes", () => {
  const client = freshHttpClient();
  assert(client !== null);
  client.close();
});
