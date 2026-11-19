"use client";
// Status, buttons and stats. Polls the backend twice a second.
import { useEffect, useState } from "denext";
import type { AppStats, AppStatus } from "../lib/app.ts";
import type { Latency } from "../lib/viewer.ts";
import { viewer } from "./viewer-client.ts";

const ms = (n: number) => `${n.toFixed(2)} ms`;

function LatencyRow({ name, value }: { name: string; value: Latency }) {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{ms(value.p50)}</td>
      <td>{ms(value.p95)}</td>
      <td>{ms(value.max)}</td>
    </tr>
  );
}

export function Controls() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [stats, setStats] = useState<AppStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const [s, t] = await Promise.all([viewer.status(), viewer.stats()]);
        if (!live) return;
        setStatus(s as AppStatus);
        setStats(t as AppStats);
        setError(null);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const act = (fn: () => Promise<unknown>) => () => {
    fn().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  if (!status) {
    return (
      <p className="note">
        {error ?? "Connecting…"} The controls work in the desktop app (`denext task desktop`).
      </p>
    );
  }
  const v = stats?.viewer;
  const t = stats?.transport;
  return (
    <>
      <section className="card">
        <h2>Status</h2>
        <dl>
          <dt>Native library</dt>
          <dd>{status.library.path ?? status.library.error ?? "not loaded yet"}</dd>
          <dt>Receiving</dt>
          <dd>
            {status.whip
              ? `WHIP at ${status.whip}`
              : status.encodedTransform
              ? "starting…"
              : "this runtime has no RTCRtpScriptTransform (needs 3.0.0-denext.26+)"}
          </dd>
          <dt>Sender</dt>
          <dd>
            {status.session
              ? `${status.session.codec.toUpperCase()}, ${status.session.state}`
              : status.playing
              ? `playing ${status.playing}`
              : "none: run `denext task send`"}
          </dd>
          <dt>Video window</dt>
          <dd>
            {status.viewer?.window
              ? `${
                status.viewer.window.fullscreen ? "full screen" : "window"
              } on display ${status.viewer.window.display}`
              : "closed"}
          </dd>
        </dl>
        <div className="buttons">
          <label>
            Display{" "}
            <input
              type="number"
              min={0}
              max={16}
              value={display}
              onChange={(e) => setDisplay(Number((e.target as HTMLInputElement).value) || 0)}
            />
          </label>
          <button type="button" onClick={act(() => viewer.open({ fullscreen: true, display }))}>
            Full screen
          </button>
          <button type="button" onClick={act(() => viewer.open({ fullscreen: false, display }))}>
            Window
          </button>
          <button type="button" onClick={act(() => viewer.hide())}>Hide</button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
      {v && (
        <section className="card">
          <h2>Stats</h2>
          <p>
            {v.codec.toUpperCase()} {v.width}×{v.height}, {v.hardware === null
              ? "decoder starting"
              : v.hardware
              ? "hardware decode"
              : "software decode"}
          </p>
          <p>
            {v.pushed} pushed · {v.decoded} decoded · {v.presented} on screen ({v.presentedUntimed}
            {" "}
            untimed) · {v.dropped} dropped · {v.decodeErrors} errors
          </p>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>p50</th>
                <th>p95</th>
                <th>max</th>
              </tr>
            </thead>
            <tbody>
              <LatencyRow name="push → decoded" value={v.decode} />
              <LatencyRow name="decoded → on screen" value={v.present} />
              <LatencyRow name="push → on screen" value={v.total} />
            </tbody>
          </table>
          {t && (
            <p className="note">
              Hand-off (frame reassembled → native push): {ms(t.handoffMean)} mean,{" "}
              {ms(t.handoffMax)} max in the last second; {t.keyFrameRequests} key frame requests.
            </p>
          )}
        </section>
      )}
    </>
  );
}
