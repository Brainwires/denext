"use client";
// Runs the checks (`checks.ts`) in the window and shows each result. Launched by the window test
// (`KITCHEN_SINK_AUTORUN=1`), it runs them at once, hands the results to the `kitchen` extension
// (which writes the runner's report) and quits; opened by hand, it waits for the button.

import { useEffect, useRef, useState } from "denext";
import { type DeepLinkEvent, onDeepLink, onOpenFile, type OpenedFile } from "denext/mobile";
import { quitApp } from "denext/desktop/window";
import {
  type CheckContext,
  type CheckResult,
  CHECKS,
  kitchen,
  type KitchenSetup,
  runChecks,
} from "./checks.ts";

export function KitchenSink() {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [state, setState] = useState<
    "loading" | "idle" | "running" | "done" | "error"
  >("loading");
  const [error, setError] = useState("");
  const ctx = useRef<CheckContext | null>(null);

  const run = async () => {
    if (!ctx.current) return;
    setState("running");
    setResults([]);
    const all = await runChecks(
      ctx.current,
      (r) => setResults((prev) => [...prev, r]),
    );
    setState("done");
    if (ctx.current.setup.autorun) {
      await kitchen.report({ results: all, expected: CHECKS.map(([name]) => name) });
      await quitApp();
    }
  };

  useEffect(() => {
    // Subscribe first: a link or file the app was launched with goes to the first subscriber.
    const links: DeepLinkEvent[] = [];
    const files: OpenedFile[] = [];
    const stopLinks = onDeepLink((link) => links.push(link), { route: false });
    const stopFiles = onOpenFile((file) => files.push(file));
    kitchen.setup({}).then((setup: KitchenSetup) => {
      ctx.current = { setup, links, files };
      setState("idle");
      if (setup.autorun) void run();
    }, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    });
    return () => {
      stopLinks();
      stopFiles();
    };
  }, []);

  const failed = results.filter((r) => r.status === "fail").length;
  return (
    <div>
      <p class="status" data-state={state}>
        {state === "loading" && "Connecting to the desktop runtime…"}
        {state === "error" && `Not in a denext desktop window (${error}).`}
        {state === "idle" && `${CHECKS.length} checks ready.`}
        {state === "running" && `Running… ${results.length}/${CHECKS.length}`}
        {state === "done" &&
          `${results.length - failed}/${results.length} passed or skipped, ${failed} failed.`}
      </p>
      <button
        type="button"
        disabled={state !== "idle" && state !== "done"}
        onClick={() => run()}
      >
        Run checks
      </button>
      <table>
        <tbody>
          {results.map((r) => (
            <tr key={r.name} data-status={r.status}>
              <td>
                {r.status === "pass" ? "✓" : r.status === "skip" ? "–" : "✗"}
              </td>
              <td>{r.name}</td>
              <td>{r.detail}</td>
              <td>{r.ms} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
