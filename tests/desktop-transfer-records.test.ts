// The Deno Desktop `fs` capability's download records (`src/desktop/caps/transfer-records.ts`) on
// their own: what a records file that is not ours loads as (malformed, oversized, not a file), the
// retention edges at load, a failed atomic write, and the attempt-keyed `update` / `remove` misses.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  isCredentialHeader,
  SETTLED_RETENTION_MS,
  TRANSFER_RECORDS_DIR,
  type TransferRecord,
  TransferRecords,
} from "../src/desktop/caps/transfer-records.ts";
import { removeTempDir } from "./helpers/temp.ts";

const NOW = 1_800_000_000_000;

/** A well-formed record, `over` changing fields. */
function record(over: Partial<TransferRecord> = {}): TransferRecord {
  return {
    id: "t1",
    url: "https://example.test/a.bin",
    directory: "data",
    path: "a.bin",
    headers: { authorization: "Bearer x" },
    state: "paused",
    bytes: 10,
    total: 100,
    resumable: true,
    attempt: "a1",
    updatedAt: NOW,
    ...over,
  };
}

/** Run `fn` with a fresh data directory, removed afterwards. */
async function withDataDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await Deno.makeTempDir({ prefix: "denext-transfer-records-" });
  try {
    await fn(dataDir);
  } finally {
    await removeTempDir(dataDir);
  }
}

/** The records file of `dataDir`. */
function recordsFile(dataDir: string): string {
  return join(dataDir, TRANSFER_RECORDS_DIR, "transfers.json");
}

/** Write `text` as `dataDir`'s records file. */
async function writeRecordsFile(dataDir: string, text: string): Promise<void> {
  await Deno.mkdir(join(dataDir, TRANSFER_RECORDS_DIR), { recursive: true });
  await Deno.writeTextFile(recordsFile(dataDir), text);
}

/** Load `dataDir`'s records, keeping each as it was; returns them and the ones expired. */
async function load(
  dataDir: string,
  now = NOW,
  restore: (r: TransferRecord) => Promise<TransferRecord | undefined> = (r) => Promise.resolve(r),
): Promise<{ records: TransferRecords; expired: string[] }> {
  const records = new TransferRecords(dataDir, () => now);
  const expired: string[] = [];
  await records.ready(restore, (r) => {
    expired.push(r.id);
    return Promise.resolve();
  });
  return { records, expired };
}

Deno.test({
  name: "transfer records: a records file that is not JSON, or not an array, loads as none",
}, async () => {
  for (const text of ["{not json", JSON.stringify({ records: [record()] }), "null", "42"]) {
    await withDataDir(async (dataDir) => {
      await writeRecordsFile(dataDir, text);
      const { records } = await load(dataDir);
      assertEquals(records.all(), [], text);
    });
  }
});

Deno.test({
  name: "transfer records: each malformed entry is dropped; the well-formed ones load",
}, async () => {
  await withDataDir(async (dataDir) => {
    const good = record({
      id: "good",
      headers: { accept: "*/*" },
      status: 503,
      code: "HTTP",
      error: "busy",
    });
    const bad: unknown[] = [
      null,
      "t1",
      7,
      { ...record({ id: "no-headers" }), headers: undefined },
      { ...record({ id: "null-headers" }), headers: null },
      { ...record({ id: "array-headers" }), headers: ["a"] },
      { ...record({ id: "number-header" }), headers: { "x-n": 1 } },
      { ...record(), id: "" },
      { ...record({ id: "bad-directory" }), directory: "picked" },
      { ...record({ id: "bad-state" }), state: "cancelled" },
      { ...record({ id: "negative-bytes" }), bytes: -1 },
      { ...record({ id: "nan-total" }), total: "100" },
      { ...record({ id: "bad-resumable" }), resumable: "yes" },
      { ...record({ id: "bad-attempt" }), attempt: 3 },
      { ...record({ id: "infinite-time" }), updatedAt: null },
      { ...record({ id: "bad-status" }), status: "503" },
      { ...record({ id: "bad-code" }), code: 1 },
      { ...record({ id: "bad-file" }), file: false },
      { ...record({ id: "bad-withheld" }), withheld: "yes" },
    ];
    await writeRecordsFile(dataDir, JSON.stringify([...bad, good]));
    const { records } = await load(dataDir);
    assertEquals(records.all(), [good]);
  });
});

Deno.test({
  name: "transfer records: a records file over the size cap, or one that is not a file, is none",
}, async () => {
  await withDataDir(async (dataDir) => {
    // A valid list padded past 4 MiB: refused for its size alone, never parsed.
    const padded = JSON.stringify([record()]).slice(0, -1) + " ".repeat(4 * 1024 * 1024) + "]";
    await writeRecordsFile(dataDir, padded);
    assert(JSON.parse(padded).length === 1, "the padded file is a valid list");
    const { records } = await load(dataDir);
    assertEquals(records.all(), []);
  });
  await withDataDir(async (dataDir) => {
    await Deno.mkdir(recordsFile(dataDir), { recursive: true });
    const { records } = await load(dataDir);
    assertEquals(records.all(), []);
  });
  await withDataDir(async (dataDir) => {
    const { records } = await load(dataDir);
    assertEquals(records.all(), [], "no records file at all");
  });
});

Deno.test({
  name: "transfer records: retention drops a settled record at exactly 7 days, not a moment before",
}, async () => {
  await withDataDir(async (dataDir) => {
    const at = NOW - SETTLED_RETENTION_MS;
    const list = [
      record({ id: "done-at-limit", state: "done", headers: {}, updatedAt: at }),
      record({ id: "done-just-in", state: "done", headers: {}, updatedAt: at + 1 }),
      record({ id: "failed-final-old", state: "failed", resumable: false, updatedAt: at - 1 }),
      record({ id: "failed-resumable-old", state: "failed", resumable: true, updatedAt: at - 1 }),
      record({ id: "paused-old", state: "paused", updatedAt: at - 1 }),
    ];
    await writeRecordsFile(dataDir, JSON.stringify(list));
    const { records, expired } = await load(dataDir);
    assertEquals(expired.sort(), ["done-at-limit", "failed-final-old"]);
    assertEquals(records.all().map((r) => r.id), [
      "done-just-in",
      "failed-resumable-old",
      "paused-old",
    ]);
    // The expiry changed the records, so the file was rewritten without them.
    const saved = JSON.parse(await Deno.readTextFile(recordsFile(dataDir))) as TransferRecord[];
    assertEquals(saved.map((r) => r.id), ["done-just-in", "failed-resumable-old", "paused-old"]);
  });
});

Deno.test({
  name: "transfer records: a failing expire still drops; a failing restore keeps; undefined drops",
}, async () => {
  await withDataDir(async (dataDir) => {
    const list = [
      record({ id: "old", state: "done", headers: {}, updatedAt: NOW - SETTLED_RETENTION_MS }),
      record({ id: "throws" }),
      record({ id: "dropped" }),
      record({ id: "running", state: "running" }),
    ];
    await writeRecordsFile(dataDir, JSON.stringify(list));
    const records = new TransferRecords(dataDir, () => NOW);
    const loading = records.ready(
      (r) => {
        if (r.id === "throws") return Promise.reject(new Error("restore failed"));
        if (r.id === "dropped") return Promise.resolve(undefined);
        return Promise.resolve({ ...r, state: "paused" as const });
      },
      () => Promise.reject(new Error("expire failed")),
    );
    assert(records.ready(() => Promise.resolve(undefined), () => Promise.resolve()) === loading);
    await loading;
    assertEquals(records.all().map((r) => [r.id, r.state]), [
      ["running", "paused"],
      ["throws", "paused"],
    ]);
    const saved = JSON.parse(await Deno.readTextFile(recordsFile(dataDir))) as TransferRecord[];
    assertEquals(saved.map((r) => r.id), ["running", "throws"]);
  });
});

Deno.test({
  name: "transfer records: an unchanged load writes nothing back",
}, async () => {
  await withDataDir(async (dataDir) => {
    // Formatted unlike the module's own JSON.stringify, so a rewrite would show.
    const text = JSON.stringify([record()], null, 2);
    await writeRecordsFile(dataDir, text);
    const { records } = await load(dataDir);
    assertEquals(records.all().length, 1);
    assertEquals(await Deno.readTextFile(recordsFile(dataDir)), text);
  });
});

Deno.test({
  name: "transfer records: update and remove miss an unknown id and another attempt's record",
}, async () => {
  await withDataDir(async (dataDir) => {
    const { records } = await load(dataDir);
    await records.start(record({ attempt: "a2" }));
    assertEquals(await records.update("nope", "a2", { bytes: 20 }), false);
    assertEquals(await records.update("t1", "a1", { bytes: 20 }), false, "a stale attempt");
    assertEquals(records.get("t1")?.bytes, 10);
    assertEquals(await records.remove("nope"), false);
    assertEquals(await records.remove("t1", "a1"), false, "a stale attempt");
    assert(records.get("t1"));

    // The current attempt changes it; `undefined` removes an optional field; settling drops the
    // headers.
    assert(await records.update("t1", "a2", { state: "failed", code: "NETWORK", error: "cut" }));
    assertEquals(records.get("t1")?.headers, { authorization: "Bearer x" }, "still resumable");
    assert(await records.update("t1", "a2", { code: undefined, error: undefined, bytes: 100 }));
    assertEquals([records.get("t1")?.code, records.get("t1")?.error], [undefined, undefined]);
    assert(!("code" in records.get("t1")!));
    assert(await records.update("t1", "a2", { state: "done", file: "/abs/a.bin" }));
    assertEquals(records.get("t1")?.headers, {});
    const saved = JSON.parse(await Deno.readTextFile(recordsFile(dataDir))) as TransferRecord[];
    assertEquals(saved[0].headers, {});
    assertEquals(saved[0].file, "/abs/a.bin");

    // Any attempt removes it without one; the last record gone takes the file and folder.
    assert(await records.remove("t1"));
    assertEquals(records.all(), []);
    assertEquals(await exists(join(dataDir, TRANSFER_RECORDS_DIR)), false);
  });
});

Deno.test({
  name: "transfer records: a failed atomic write leaves no temp file, and later saves still run",
}, async () => {
  await withDataDir(async (dataDir) => {
    const { records } = await load(dataDir);
    // A non-empty folder where the records file goes: the temp file is written, but the rename
    // over the records file fails.
    await Deno.mkdir(join(recordsFile(dataDir), "blocker"), { recursive: true });
    await records.start(record());
    assertEquals(records.get("t1")?.bytes, 10, "the change is kept in memory");
    const left = [];
    for await (const e of Deno.readDir(join(dataDir, TRANSFER_RECORDS_DIR))) left.push(e.name);
    assertEquals(left, ["transfers.json"], "the temp file was removed");
    assert((await Deno.stat(recordsFile(dataDir))).isDirectory);

    // Once the path is free again, the next save goes through: the queue is not stuck.
    await Deno.remove(recordsFile(dataDir), { recursive: true });
    assert(await records.update("t1", "a1", { bytes: 50 }));
    const saved = JSON.parse(await Deno.readTextFile(recordsFile(dataDir))) as TransferRecord[];
    assertEquals(saved.map((r) => r.bytes), [50]);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(recordsFile(dataDir))).mode! & 0o777, 0o600);
    }
  });
});

/** Whether `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

Deno.test("transfer records: which request headers count as credentials", () => {
  for (
    const name of [
      "Authorization",
      "proxy-authorization",
      "Cookie",
      "X-Api-Key",
      "x-auth-token",
      "X-Amz-Security-Token",
      "x-session-id",
      "x-client-secret",
      "x-password",
      "x-signature",
      "x-credential",
    ]
  ) assert(isCredentialHeader(name), name);
  for (const name of ["accept", "accept-language", "x-tenant", "user-agent", "x-request-id"]) {
    assert(!isCredentialHeader(name), name);
  }
});

Deno.test({
  name:
    "transfer records SECURITY: the file never holds a credential header; a loaded one is withheld",
}, async () => {
  await withDataDir(async (dataDir) => {
    const records = new TransferRecords(dataDir, () => NOW);
    const headers = { authorization: "Bearer x", "x-api-key": "k", accept: "*/*" };
    await records.start({ ...record({ headers }) });
    // In memory, for this launch's resume: every header.
    assertEquals(records.get("t1")?.headers, headers);
    assertEquals(records.get("t1")?.withheld, undefined);
    const file = await Deno.readTextFile(recordsFile(dataDir));
    assert(!file.includes("Bearer x") && !file.includes('"k"'), file);
    // A restart loads what the file holds, marked so a resume asks for the headers again.
    const { records: after } = await load(dataDir);
    assertEquals(after.get("t1")?.headers, { accept: "*/*" });
    assertEquals(after.get("t1")?.withheld, true);
    // A record with no credential header is written as it is.
    await after.start(record({ id: "t2", headers: { accept: "*/*" } }));
    const t2 = (JSON.parse(await Deno.readTextFile(recordsFile(dataDir))) as TransferRecord[])
      .find((r) => r.id === "t2");
    assertEquals(t2?.withheld, undefined);
    // A file an older build wrote with a credential in it loads without it.
    await writeRecordsFile(dataDir, JSON.stringify([record({ id: "old" })]));
    const { records: old } = await load(dataDir);
    assertEquals(old.get("old")?.headers, {});
    assertEquals(old.get("old")?.withheld, true);
  });
});
