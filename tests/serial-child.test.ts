import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  boundedOutput,
  ChildStallError,
  retryOnStall,
  serialChild,
  serialChildTurns,
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
