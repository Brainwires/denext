"use client";
// Runs the checks (`checks.ts`) in the window and shows each result. Launched by the window test
// (the runner leaves `kitchen-sink-runner.json` in the app's data folder), it runs them at once,
// hands the results to the `kitchen` extension (which writes the runner's report) and quits; opened
// by hand, it waits for the button and shows the manual release checks (`manual-checks.tsx`). On the window test's full-app update launches it runs only that
// phase's checks, and the install phase hands over to the updater instead of quitting. On the
// navigation launch it runs nothing: `navigation.tsx` drives that phase from the layout.

import { useEffect, useRef, useState } from "denext";
import { type DeepLinkEvent, onDeepLink, onOpenFile, type OpenedFile } from "denext/mobile";
import { quitApp } from "denext/desktop/window";
import {
  type CheckContext,
  type CheckResult,
  checksFor,
  kitchen,
  type KitchenSetup,
  runChecks,
} from "./checks.ts";
import { ManualChecks } from "./manual-checks.tsx";
import { NAVIGATION_PHASE } from "./navigation.tsx";

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
    const { autorun: auto } = ctx.current.setup;
    const all = await runChecks(
      ctx.current,
      (r) => setResults((prev) => [...prev, r]),
      // Under the runner: the check now running, so a page that never reports still says where.
      auto ? (name, i) => kitchen.mark({ name: "progress", data: `${i + 1} ${name}` }) : undefined,
    );
    setState("done");
    const { autorun, phase } = ctx.current.setup;
    if (autorun) {
      await kitchen.report({ results: all, expected: checksFor(phase).map(([name]) => name) });
      // The install phase: swap in the staged update and relaunch it (the updater quits the app).
      const installs = phase === "update-install" || phase === "trusted-install";
      if (installs && all.every((r) => r.status === "pass")) {
        const r = await kitchen.updateInstall({});
        await kitchen.mark({ name: "update-install", data: JSON.stringify(r) });
        if (r.ok && r.result.quitting) return;
      }
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
      // The navigation phase is the layout's (`navigation.tsx`): it clicks away from this page.
      if (setup.autorun && setup.phase !== NAVIGATION_PHASE) void run();
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
  const count = checksFor(ctx.current?.setup.phase ?? "main").length;
  return (
    <div>
      <p class="status" data-state={state}>
        {state === "loading" && "Connecting to the desktop runtime…"}
        {state === "error" && `Not in a denext desktop window (${error}).`}
        {state === "idle" && `${count} checks ready.`}
        {state === "running" && `Running… ${results.length}/${count}`}
        {state === "done" &&
          `${results.length - failed}/${results.length} passed or skipped, ${failed} failed.`}
      </p>
      {
        // Opened by hand only: the window test (autorun) never mounts the manual checks.
        ctx.current && !ctx.current.setup.autorun && state !== "loading" && (
          <ManualChecks rpIds={ctx.current.setup.passkeyRpIds ?? []} />
        )
      }
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
