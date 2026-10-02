import { Callout, Code, DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Browser APIs",
  description:
    "Small, web-standard client helpers from denext — keep the screen awake, Picture-in-Picture, cross-tab coordination — each with a graceful SSR / no-support fallback.",
};

export default function BrowserApis() {
  return (
    <DocsShell
      active="browser-apis"
      title="Browser APIs"
      lead="Small, web-standard client helpers exported from denext — keep the screen awake, pop a video into Picture-in-Picture, and coordinate across tabs — each with a graceful SSR / no-support fallback."
    >
      <h2>Keep the screen awake — useWakeLock</h2>
      <p>
        <code>useWakeLock</code> is a hook over the Screen Wake Lock API (<code>
          navigator.wakeLock
        </code>){" "}
        for video players, recipe steps, dashboards, and scanners. Next.js ships no equivalent, so
        the base surface mirrors the community <code>react-screen-wake-lock</code> hook.
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
        The screen is one device-global resource, so the hook is a hybrid: each instance owns its
        own claim, but a single real lock is shared and refcounted underneath.
      </p>
      <ul>
        <li>
          <code>request()</code> / <code>release()</code> act on <strong>this instance's</strong>
          {" "}
          claim; <code>release()</code> sleeps the screen only when the <em>last</em>{" "}
          claim drops. Unmount drops the claim automatically.
        </li>
        <li>
          <code>released</code> is per-instance: <code>undefined</code> before its first request,
          {" "}
          <code>false</code> while held, <code>true</code> once dropped.
        </li>
        <li>
          <code>count</code> and <code>active</code> are <strong>global</strong>{" "}
          — every instance sees the same values, so a component that never requested still knows the
          screen is held.
        </li>
        <li>
          <code>releaseAll()</code>{" "}
          is the global kill-switch: it drops every claim across all instances and sleeps the
          screen.
        </li>
      </ul>

      <Callout kind="note">
        The browser releases a screen lock whenever the tab is hidden; the hook re-acquires it when
        the page becomes visible again. On the server, or without the API, <code>isSupported</code>
        {" "}
        is <code>false</code> and the actions are no-ops — the same component renders everywhere.
      </Callout>

      <h2>Picture-in-Picture — usePictureInPicture</h2>
      <p>
        <code>usePictureInPicture</code> pops a <code>{"<video>"}</code>{" "}
        out into a floating window. Attach the returned <code>ref</code>{" "}
        to the video and drive it with <code>enter</code> / <code>exit</code> / <code>toggle</code>
        {" "}
        (from a click — the browser requires a user gesture to enter PiP).
      </p>
      <Code lang="tsx">
        {`"use client";
import { usePictureInPicture } from "denext";

export function Player({ src }: { src: string }) {
  const pip = usePictureInPicture();
  return (
    <>
      <video ref={pip.ref} src={src} controls />
      <button disabled={!pip.isSupported} onClick={() => pip.toggle()}>
        {pip.isActive ? "Exit" : "Pop out"}
      </button>
    </>
  );
}`}
      </Code>
      <ul>
        <li>
          <code>isActive</code> is per-video (this one is in PiP); PiP is a browser singleton, so
          {" "}
          <code>isPiPOpen</code> is the <strong>global</strong>{" "}
          "any video is in PiP" read that every instance shares.
        </li>
        <li>
          <code>pipWindow</code> exposes the floating window's{" "}
          <code>width</code>/<code>height</code> while active;{" "}
          <code>{"{ onEnter, onExit, onResize, onError }"}</code> cover the lifecycle.
        </li>
      </ul>
      <Callout kind="note">
        <code>enter()</code>/<code>toggle()</code>{" "}
        must run inside an event handler — the browser only grants PiP on a user gesture. As with
        the other hooks, it's a no-op during SSR / where unsupported.
      </Callout>

      <h2>Coordinate across tabs — withWebLock</h2>
      <p>
        For "only one tab should do this" work — single-flighting an auth-token refresh, a one-time
        client migration, or electing a leader tab — denext exports{" "}
        <code>withWebLock</code>, a thin wrapper over the Web Locks API. See{" "}
        <a href="/docs/auth">Auth → cross-tab token refresh</a> for the full example.
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
