#!/usr/bin/env -S deno run -A
/// <reference lib="dom" />
/**
 * web-smoke.ts: serves the web app's export (web/out) and opens every denext impl in headless
 * Chromium, then drives the same `window.__bench` actions the adb harness sends by deep link.
 * A cell passes when it prints SCROLLBENCH_READY (or SCROLLBENCH_SKIPPED for a skipped cell),
 * every action returns ok, and the page logs no error. No device, no emulator.
 *
 *   (cd web && deno task export)
 *   deno run -A harness/web-smoke.ts [--kind chat] [--n 10000] [--list legend,virtua]
 *
 * Exit code 1 when any cell fails.
 */

import { launch } from "@astral/astral";
import type { Kind } from "../shared/data.ts";
import { IMPLS, parseMarkerLine } from "../shared/scenarios.ts";
import { parseArgs } from "./parse.ts";

const { flags } = parseArgs(Deno.args);
const kind = (typeof flags.kind === "string" ? flags.kind : "chat") as Kind;
const n = typeof flags.n === "string" ? Number(flags.n) : 10_000;
const only = typeof flags.list === "string" ? flags.list.split(",") : null;
const OUT = new URL("../web/out/", import.meta.url);

const MIME: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  png: "image/png",
  wasm: "application/wasm",
  json: "application/json",
};

const server = Deno.serve(
  { port: 0, hostname: "127.0.0.1", onListen() {} },
  async (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = path === "/" || !path.includes(".") ? "index.html" : path.slice(1);
    try {
      const body = await Deno.readFile(new URL(file, OUT));
      return new Response(body, {
        headers: {
          "content-type": MIME[file.split(".").pop()!] ??
            "application/octet-stream",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
);
const origin = `http://127.0.0.1:${server.addr.port}`;

interface CellResult {
  list: string;
  outcome: "ready" | "skipped" | "error" | "timeout";
  readyMs?: number;
  mounted?: number;
  actions: string[];
  errors: string[];
  notes?: unknown;
}

const browser = await launch({
  headless: true,
  args: Deno.env.get("CI") ? ["--no-sandbox", "--disable-dev-shm-usage"] : [],
});
const results: CellResult[] = [];
await Deno.mkdir(new URL("../results/", import.meta.url), { recursive: true });
try {
  for (const impl of IMPLS.filter((d) => d.app === "denext")) {
    if (only && !only.includes(impl.id)) continue;
    const page = await browser.newPage();
    await page.setViewportSize({ width: 412, height: 915 });
    const lines: string[] = [];
    const errors: string[] = [];
    page.addEventListener("console", (e) => {
      // deno-lint-ignore no-explicit-any
      const d = (e as any).detail;
      const text = String(d?.text ?? "");
      lines.push(text);
      if (d?.type === "error") errors.push(text);
    });
    await page.goto(`${origin}/?list=${impl.id}&kind=${kind}&n=${n}&seed=1`);
    const result: CellResult = {
      list: impl.id,
      outcome: "timeout",
      actions: [],
      errors,
    };
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && result.outcome === "timeout") {
      for (const line of lines.splice(0)) {
        const m = parseMarkerLine(line);
        if (m?.marker === "ready") {
          result.outcome = "ready";
          result.readyMs = m.data.ms as number;
          result.mounted = m.data.mounted as number;
          result.notes = m.data.notes;
        } else if (m?.marker === "skipped") {
          result.outcome = "skipped";
          result.notes = m.data.reason;
        } else if (m?.marker === "error") {
          result.outcome = "error";
          errors.push(String(m.data.message));
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (result.outcome === "ready") {
      const script = [
        ["scrollToIndex", Math.floor(n / 2)],
        ["scrollToIndex", n - 1],
        ["scrollToStart", 0],
        ["scrollToEnd", 0],
        ["append", 50],
        ["prepend", 50],
      ] as const;
      for (const [op, arg] of script) {
        let info: { ok: boolean; ms: number; reason?: string; count?: number };
        try {
          info = await page.evaluate(
            (op: string, arg: number) =>
              // deno-lint-ignore no-explicit-any
              (window as any).__bench.run({ op, k: arg, i: arg }),
            { args: [op, arg] },
          ) as typeof info;
        } catch (e) {
          info = { ok: false, ms: 0, reason: `page did not answer: ${(e as Error).name}` };
        }
        result.actions.push(`${op}:${info.ok ? `ok ${info.ms}ms` : `FAIL ${info.reason}`}`);
        if (!info.ok && !(kind === "sections" && (op === "append" || op === "prepend"))) {
          errors.push(`${op} failed: ${info.reason}`);
          if (info.reason?.startsWith("page did not answer")) break;
        }
      }
      // A real scroll: the rows under the viewport after a big wheel must be rows.
      await page.evaluate(() => {
        const el = [...document.querySelectorAll<HTMLElement>("*")].find((e) =>
          e.scrollHeight > e.clientHeight + 10 &&
          getComputedStyle(e).overflowY !== "visible"
        );
        if (el) el.scrollTop = el.scrollHeight / 3;
      }).catch(() => errors.push("page did not answer to a scroll"));
      await new Promise((r) => setTimeout(r, 300));
      const mountedAfter = await page.evaluate(() =>
        document.querySelectorAll(".sb-fixed,.sb-header,.sb-chat,.sb-image")
          .length
      );
      if (mountedAfter === 0) errors.push("no rows mounted after scrolling");
      if (mountedAfter < 0) errors.push("page did not answer after scrolling");
      await page.screenshot().then((png) =>
        Deno.writeFile(
          new URL(
            `../results/web-smoke-${impl.id}-${kind}-${n}.png`,
            import.meta.url,
          ),
          png,
        )
      ).catch(() => {});
    }
    if (errors.length && result.outcome === "ready") result.outcome = "error";
    results.push(result);
    console.log(
      `${impl.id.padEnd(13)} ${result.outcome.padEnd(8)} ready ${result.readyMs ?? "-"} ms, ` +
        `mounted ${result.mounted ?? "-"}  ${result.actions.join(" ")}` +
        (result.notes ? `  notes ${JSON.stringify(result.notes)}` : "") +
        (errors.length ? `\n    errors: ${errors.join(" | ")}` : ""),
    );
    await page.close();
  }
} finally {
  await browser.close();
  await server.shutdown();
}

const bad = results.filter((r) => r.outcome === "error" || r.outcome === "timeout");
console.log(
  `\n${results.length - bad.length}/${results.length} cells ok (kind=${kind}, n=${n})`,
);
if (bad.length) Deno.exit(1);
