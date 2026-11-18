"use client";
// The full-screen viewer: the pipeline (lib/pipeline/session.ts) draws into the stage; this
// component adds the stats overlay and the controls. Keys: F full screen, S stats.

import { useEffect, useRef, useState } from "denext";
import { useKeepAwake } from "denext/mobile";
import { currentFullscreenMethod, setImmersive } from "../lib/fullscreen.ts";
import { type SessionView, ViewerSession } from "../lib/pipeline/session.ts";

function formatStats(view: SessionView): string[] {
  const s = view.stats;
  const size = s.width ? `${s.width}×${s.height}` : "—";
  const jitter = s.jitterMs === null ? "—" : `${s.jitterMs.toFixed(1)} ms`;
  return [
    `pipeline   ${view.pipeline}`,
    ...(view.fallback ? [`fallback   ${view.fallback}`] : []),
    `codec      ${s.codec ?? "—"}${s.acceleration ? ` (${s.acceleration})` : ""}`,
    `resolution ${size}`,
    `fps        ${s.fps.toFixed(1)}`,
    `decode     ${s.decodeMs ? `${s.decodeMs.toFixed(2)} ms` : "—"}`,
    `jitter     ${jitter}`,
    `room       ${view.room}`,
    `status     ${view.status}`,
  ];
}

export function Viewer() {
  const stage = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [showStats, setShowStats] = useState(true);
  const [immersive, setImmersiveState] = useState(false);
  const [method, setMethod] = useState("");
  useKeepAwake(true);

  useEffect(() => {
    const session = new ViewerSession({
      surface: surface.current!,
      video: video.current!,
      location,
      onUpdate: setView,
    });
    session.start().catch((err) => console.error("viewer:", err));
    setMethod(currentFullscreenMethod());
    return () => session.stop();
  }, []);

  const toggleFullscreen = () => {
    const next = !immersive;
    setImmersive(next, stage.current!).then(
      (used) => setImmersiveState(next && used !== "none"),
      (err) => console.error("full screen:", err),
    );
  };

  useEffect(() => {
    // Esc (or the OS) can leave the Fullscreen API's full screen behind our back.
    const sync = () => {
      if (method === "fullscreen-api") {
        setImmersiveState(document.fullscreenElement !== null);
      }
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "s" || e.key === "S") setShowStats((on) => !on);
    };
    document.addEventListener("fullscreenchange", sync);
    globalThis.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      globalThis.removeEventListener("keydown", keys);
    };
  });

  return (
    <div class="stage" ref={stage} onDblClick={toggleFullscreen}>
      <video ref={video} class="stage-video" playsInline muted autoPlay />
      {/* The session's canvas lives here: an element this component never renders children into. */}
      <div class="stage-surface" ref={surface} />
      {showStats && view
        ? (
          <pre
            class="stats"
            data-testid="stats"
          >{formatStats(view).join("\n")}</pre>
        )
        : null}
      <div class="controls">
        <button
          type="button"
          onClick={toggleFullscreen}
          disabled={method === "none"}
        >
          {immersive ? "Exit full screen" : "Full screen"}
        </button>
        <button type="button" onClick={() => setShowStats((on) => !on)}>
          {showStats ? "Hide stats" : "Stats"}
        </button>
        <a
          class="button"
          href={`/send${typeof location === "undefined" ? "" : location.search}`}
        >
          Sender
        </a>
      </div>
    </div>
  );
}
