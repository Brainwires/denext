import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  boundedOutput,
  childDeadlineMs,
  ChildStallError,
  lockDir,
  retryOnStall,
  serialChild,
  serialChildTurns,
  spawnExclusive,
} from "../src/build/serial-child.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

Deno.test("serialChild: concurrent callers run one at a time, in call order", async () => {
  let active = 0;
  let most = 0;
  const order: number[] = [];
  const before = serialChildTurns();
  const results = await Promise.all([0, 1, 2, 3, 4].map((i) =>
    serialChild(async () => {
      active++;
      most = Math.max(most, active);
      await sleep(20);
      order.push(i);
      active--;
      return i * 10;
    })
  ));
  assertEquals(most, 1);
  assertEquals(order, [0, 1, 2, 3, 4]);
  assertEquals(results, [0, 10, 20, 30, 40]);
  assertEquals(serialChildTurns() - before, 5);
});

Deno.test("spawnExclusive: on Windows a long-lived spawn waits out a running child's turn", async () => {
  const events: string[] = [];
  const before = serialChildTurns();
  let release: (() => void) | undefined;
  const held = serialChild(async () => {
    events.push("info started");
    await new Promise<void>((r) => release = r);
    events.push("info exited");
  });
  // The turn starts once the process lock is free (another test file may hold it).
  while (!release) await sleep(5);
  const spawned = spawnExclusive(() => {
    events.push("service spawned");
    return 7;
  }, "windows");
  await sleep(30);
  assertEquals(events, ["info started"], "the spawn waits while the child holds its pipes");
  release!();
  assertEquals(await spawned, 7);
  await held;
  assertEquals(events, ["info started", "info exited", "service spawned"]);
  // The spawn's turn is not a child's: the turn counter counts children only.
  assertEquals(serialChildTurns() - before, 1);
  // A failed spawn frees the turn.
  await assertRejects(
    () =>
      spawnExclusive(() => {
        throw new Error("no binary");
      }, "windows"),
    Error,
    "no binary",
  );
  assertEquals(await serialChild(() => Promise.resolve("next")), "next");
});

Deno.test("spawnExclusive: elsewhere it spawns at once, even during a child's turn", async () => {
  let release: (() => void) | undefined;
  const held = serialChild(() => new Promise<void>((r) => release = r));
  while (!release) await sleep(5);
  for (const os of ["darwin", "linux"] as const) {
    assertEquals(await spawnExclusive(() => os, os), os);
  }
  release!();
  await held;
});

Deno.test("serialChild: a failed turn passes its error on and frees the queue", async () => {
  await assertRejects(() => serialChild(() => Promise.reject(new Error("boom"))), Error, "boom");
  assertEquals(await serialChild(() => Promise.resolve("next")), "next");
});

Deno.test("serialChild: isolates of one process take turns through the process lock", async () => {
  const src = `
    import { serialChild } from ${
    JSON.stringify(new URL("../src/build/serial-child.ts", import.meta.url).href)
  };
    self.onmessage = async () => {
      const span = await serialChild(async () => {
        const start = performance.timeOrigin + performance.now();
        await new Promise((r) => setTimeout(r, 300));
        return [start, performance.timeOrigin + performance.now()];
      });
      self.postMessage(span);
    };
  `;
  const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
  const workers = [0, 1, 2].map(() => new Worker(url, { type: "module" }));
  try {
    // Each worker is ready once its module has loaded; a first message is queued until then.
    const spans = await Promise.all(
      workers.map((w) =>
        new Promise<[number, number]>((resolve, reject) => {
          w.onmessage = (e) => resolve(e.data);
          w.onerror = (e) => reject(e);
          w.postMessage("go");
        })
      ),
    );
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      // A small tolerance for the two isolates' clocks.
      assert(spans[i][0] >= spans[i - 1][1] - 5, `turns overlapped: ${JSON.stringify(spans)}`);
    }
  } finally {
    for (const w of workers) w.terminate();
    URL.revokeObjectURL(url);
  }
});

Deno.test("retryOnStall: a stall is reported with its pid and arguments and retried once", async () => {
  const lines: string[] = [];
  let attempts = 0;
  const out = await retryOnStall(
    "deno info",
    ["info", "--json", "file:///x/barrel.ts"],
    (deadline) => {
      attempts++;
      assertEquals(deadline, 1_000);
      if (attempts === 1) throw new ChildStallError("deno info", 4242, deadline, "");
      return Promise.resolve("graph");
    },
    1_000,
    (line) => lines.push(line),
  );
  assertEquals(out, "graph");
  assertEquals(attempts, 2);
  assertEquals(lines.length, 1);
  assert(lines[0].includes("pid 4242"), lines[0]);
  assert(lines[0].includes("deno info info --json file:///x/barrel.ts"), lines[0]);
});

Deno.test("retryOnStall: a second stall fails with both pids, after exactly one retry", async () => {
  const lines: string[] = [];
  let attempts = 0;
  const err = await assertRejects(
    () =>
      retryOnStall(
        "deno bundle",
        ["bundle"],
        (deadline) => {
          attempts++;
          throw new ChildStallError("deno bundle", 100 + attempts, deadline, "partial\n");
        },
        2_000,
        (line) => lines.push(line),
      ),
    ChildStallError,
  );
  assertEquals(attempts, 2);
  assertEquals(lines.length, 1);
  assert(err.message.includes("stalled twice; first pid 101"), err.message);
  assert(err.message.includes("(pid 102) was still running after 2 s and was killed"), err.message);
  assert(err.message.endsWith("partial\n"), err.message);
});

Deno.test("retryOnStall: any other failure is not retried", async () => {
  let attempts = 0;
  await assertRejects(
    () =>
      retryOnStall(
        "deno info",
        [],
        () => {
          attempts++;
          return Promise.reject(new Error("deno info failed (1)"));
        },
        1_000,
        () => {},
      ),
    Error,
    "deno info failed (1)",
  );
  assertEquals(attempts, 1);
});

Deno.test("boundedOutput: a child still running at the deadline is killed", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "console.error('waiting'); setInterval(() => {}, 1000)"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const t0 = Date.now();
  const err = await assertRejects(
    () => boundedOutput(child, { stdout: true, stderr: true }, 3_000, "deno eval"),
    ChildStallError,
  );
  assertEquals(err.pid, child.pid);
  assert(err.message.startsWith(`deno eval (pid ${child.pid}) was still running after 3 s`));
  assert(Date.now() - t0 < 30_000, `took ${Date.now() - t0} ms`);
});

Deno.test("boundedOutput: a child that exits in time returns its output", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "console.log('ok')"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = await boundedOutput(child, { stdout: true, stderr: true }, 60_000, "deno eval");
  assertEquals(out.code, 0);
  assertEquals(new TextDecoder().decode(out.stdout).trim(), "ok");
});

Deno.test("lockDir: a directory only this user reaches, never a shared /tmp", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(
    lockDir(env({ XDG_RUNTIME_DIR: "/run/user/1000", HOME: "/home/u" }), "linux"),
    join("/run/user/1000", "denext-locks"),
  );
  assertEquals(
    lockDir(env({ HOME: "/home/u" }), "linux"),
    join("/home/u", ".cache", "denext", "locks"),
  );
  assertEquals(
    lockDir(env({ HOME: "/home/u", XDG_CACHE_HOME: "/c" }), "linux"),
    join("/c", "denext", "locks"),
  );
  assertEquals(
    lockDir(env({ HOME: "/Users/u", XDG_RUNTIME_DIR: "/x" }), "darwin"),
    join("/x", "denext-locks"),
  );
  assertEquals(
    lockDir(env({ HOME: "/Users/u" }), "darwin"),
    join("/Users/u", "Library", "Caches", "denext", "locks"),
  );
  assertEquals(
    lockDir(
      env({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", XDG_RUNTIME_DIR: "/x" }),
      "windows",
    ),
    join("C:\\Users\\u\\AppData\\Local", "denext", "locks"),
  );
  assertEquals(lockDir(env({ TMPDIR: "/tmp" }), "linux"), undefined, "no home: no lock file");
});

Deno.test("childDeadlineMs: DENEXT_CHILD_DEADLINE_MS replaces a deadline; 0 turns it off", () => {
  const env = (v?: string) => (k: string) => k === "DENEXT_CHILD_DEADLINE_MS" ? v : undefined;
  assertEquals(childDeadlineMs(120_000, env()), 120_000);
  assertEquals(childDeadlineMs(120_000, env("900000")), 900_000);
  assertEquals(childDeadlineMs(120_000, env("0")), Infinity);
  assertEquals(childDeadlineMs(120_000, env("ten minutes")), 120_000, "not a number: the default");
  assertEquals(childDeadlineMs(120_000, env("-5")), 120_000);
});

Deno.test("boundedOutput: no deadline (Infinity) never kills the child", async () => {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "await new Promise((r) => setTimeout(r, 50)); console.log('done')"],
    stdout: "piped",
    stderr: "null",
    stdin: "null",
  }).spawn();
  const out = await boundedOutput(child, { stdout: true, stderr: false }, Infinity, "deno eval");
  assertEquals(out.code, 0);
  assertEquals(new TextDecoder().decode(out.stdout).trim(), "done");
});

Deno.test("serialChild: the process lock is in a private directory and is removed on exit", async () => {
  const home = await Deno.makeTempDir({ prefix: "denext_lockhome_" });
  try {
    const mod = JSON.stringify(new URL("../src/build/serial-child.ts", import.meta.url).href);
    const code = `import { lockDir, serialChild } from ${mod};
const dir = lockDir();
const seen = await serialChild(async () => [...Deno.readDirSync(dir)].map((e) => e.name));
console.log(JSON.stringify({ dir, seen, pid: Deno.pid }));`;
    const vars: Record<string, string> = Deno.build.os === "windows"
      ? { LOCALAPPDATA: home, USERPROFILE: home }
      : { HOME: home, XDG_CACHE_HOME: join(home, ".cache") };
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-check", code],
      env: { ...vars, XDG_RUNTIME_DIR: "" },
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    const { dir, seen, pid } = JSON.parse(text);
    assert(dir.startsWith(home), dir);
    assertEquals(seen, [`denext-deno-child-${pid}.lock`], "the lock was held there");
    assertEquals([...Deno.readDirSync(dir)], [], "and removed when the process exited");
    if (Deno.build.os !== "windows") {
      assertEquals(Deno.statSync(dir).mode! & 0o777, 0o700, "the directory is this user's only");
    }
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
