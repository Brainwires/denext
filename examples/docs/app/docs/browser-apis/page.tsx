import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export default function BrowserApis() {
  return (
    <DocsShell
      active="browser-apis"
      title="Browser APIs"
      lead="Small, web-standard client helpers exported from denext — coordinate across tabs, and keep the screen awake — with graceful SSR / no-support fallbacks."
    >
      <h2>Keep the screen awake — useWakeLock</h2>
      <p>
        <code>useWakeLock</code> is a hook over the Screen Wake Lock API (<code>
          navigator.wakeLock
        </code>){" "}
        for video players, recipe steps, dashboards, and scanners. Next.js ships
        no equivalent, so the base surface mirrors the community{" "}
        <code>react-screen-wake-lock</code> hook.
      </p>
      <Code lang="tsx">
        {`"use client";
import { useWakeLock } from "denext";

export function CookMode() {
  const wake = useWakeLock();
  return wake.released === false
    ? <button onClick={() => wake.release()}>Let screen sleep</button>
    : <button disabled={!wake.isSupported} onClick={() => wake.request()}>
        Keep screen on ({wake.count} active)
      </button>;
}`}
      </Code>

      <h2>It's a refcounted singleton</h2>
      <p>
        The screen is one device-global resource, so the hook is a hybrid: each
        instance owns its own claim, but a single real lock is shared and
        refcounted underneath.
      </p>
      <ul>
        <li>
          <code>request()</code> / <code>release()</code> act on{" "}
          <strong>this instance's</strong> claim; <code>release()</code>{" "}
          sleeps the screen only when the <em>last</em>{" "}
          claim drops. Unmount drops the claim automatically.
        </li>
        <li>
          <code>released</code> is per-instance: <code>undefined</code>{" "}
          before its first request, <code>false</code> while held,{" "}
          <code>true</code> once dropped.
        </li>
        <li>
          <code>count</code> and <code>active</code> are <strong>global</strong>
          {" "}
          — every instance sees the same values, so a component that never
          requested still knows the screen is held.
        </li>
        <li>
          <code>releaseAll()</code>{" "}
          is the global kill-switch: it drops every claim across all instances
          and sleeps the screen.
        </li>
      </ul>

      <Callout kind="note">
        The browser releases a screen lock whenever the tab is hidden; the hook
        re-acquires it when the page becomes visible again. On the server, or
        without the API, <code>isSupported</code> is <code>false</code>{" "}
        and the actions are no-ops — the same component renders everywhere.
      </Callout>

      <h2>Coordinate across tabs — withWebLock</h2>
      <p>
        For "only one tab should do this" work — single-flighting an auth-token
        refresh, a one-time client migration, or electing a leader tab — denext
        exports{" "}
        <code>withWebLock</code>, a thin wrapper over the Web Locks API. See
        {" "}
        <a href="/docs/auth">Auth → cross-tab token refresh</a>{" "}
        for the full example.
      </p>
      <Code lang="ts">
        {`import { withWebLock } from "denext";

await withWebLock("auth:refresh", async () => {
  if (tokenIsFresh()) return;   // a tab ahead of us already refreshed
  await fetch("/api/refresh", { method: "POST" });
});`}
      </Code>
    </DocsShell>
  );
}
