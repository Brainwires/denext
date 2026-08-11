// Rivet Rumble — an original barrel-climber on vanilla Three.js, running on denext.
// React/denext owns the HUD + overlays + touch controls and the game *state*;
// app/engine.ts owns the WebGL canvas, physics, and render loop. They talk through
// a tiny callback API. All client-side (WebGL needs a real canvas), booted in a
// useEffect after hydration.
import { useEffect, useRef, useState } from "react";
import { Sound } from "./audio.ts";
import {
  createGame,
  type GameHandle,
  type GameState,
  type InputKey,
} from "./engine.ts";

export default function Game() {
  const mount = useRef<HTMLDivElement>(null);
  const game = useRef<GameHandle | null>(null);
  const sound = useRef<Sound | null>(null);

  const [state, setState] = useState<GameState>("ready");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const snd = new Sound();
    sound.current = snd;
    const g = createGame(el, snd, {
      onScore: setScore,
      onLives: setLives,
      onState: (s) => {
        setState(s);
        if (s === "won" || s === "lost") snd.stopMusic();
      },
    });
    game.current = g;
    return () => {
      g.dispose();
      snd.stopMusic();
    };
  }, []);

  const play = () => {
    sound.current?.ensure();
    if (!muted) sound.current?.startMusic();
    game.current?.start();
  };
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    sound.current?.setMuted(m);
  };

  // Touch/hold control → engine input.
  const hold = (k: InputKey) => ({
    onPointerDown: (e: Event) => {
      (e.currentTarget as HTMLElement).setPointerCapture?.(
        (e as PointerEvent).pointerId,
      );
      game.current?.setInput(k, true);
    },
    onPointerUp: () => game.current?.setInput(k, false),
    onPointerLeave: () => game.current?.setInput(k, false),
    onPointerCancel: () => game.current?.setInput(k, false),
  });

  return (
    <div>
      <style>{CSS}</style>
      <div class="stage" ref={mount} />

      <div class="hud">
        <div class="topbar">
          <div class="brand">
            RIVET <span class="acc">RUMBLE</span>
          </div>
          <div class="stats">
            <span class="score">{score.toLocaleString().padStart(6, "0")}</span>
            <span class="lives">
              {Array.from(
                { length: 3 },
                (_, i) => (
                  <span key={i} class={`life ${i < lives ? "" : "gone"}`}>
                    ♥
                  </span>
                ),
              )}
            </span>
            <button
              type="button"
              class="mute"
              onClick={toggleMute}
              aria-label="mute"
            >
              {muted ? "🔇" : "🔊"}
            </button>
          </div>
        </div>

        {state !== "playing" && (
          <div class="overlay">
            <div class="panel">
              {state === "ready" && (
                <>
                  <h1>
                    RIVET <span class="acc">RUMBLE</span>
                  </h1>
                  <p>
                    Climb the girders, hop the barrels the ape rolls at you, and
                    rescue the cat at the top. 🐈
                  </p>
                  <p class="keys">
                    ← → move · ↑ ↓ ladders · <b>Space</b> jump
                  </p>
                  <button type="button" class="cta" onClick={play}>
                    ▶ Play
                  </button>
                </>
              )}
              {state === "won" && (
                <>
                  <h1 class="win">You saved the cat! 🎉</h1>
                  <p>
                    Score <b>{score.toLocaleString()}</b>
                  </p>
                  <button type="button" class="cta" onClick={play}>
                    ▶ Play again
                  </button>
                </>
              )}
              {state === "lost" && (
                <>
                  <h1 class="lose">Game Over</h1>
                  <p>
                    Score <b>{score.toLocaleString()}</b>
                  </p>
                  <button type="button" class="cta" onClick={play}>
                    ▶ Retry
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {state === "playing" && (
          <div class="touch">
            <div class="dpad">
              <button type="button" class="tb up" {...hold("up")}>▲</button>
              <button type="button" class="tb left" {...hold("left")}>◀</button>
              <button type="button" class="tb right" {...hold("right")}>
                ▶
              </button>
              <button type="button" class="tb down" {...hold("down")}>▼</button>
            </div>
            <button type="button" class="tb jump" {...hold("jump")}>
              JUMP
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const CSS = `
.stage { position: fixed; inset: 0; }
.hud { position: fixed; inset: 0; pointer-events: none; font-family: system-ui, sans-serif; color: #e5e7eb; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; }
.brand { font-weight: 900; letter-spacing: 1px; font-size: 15px; text-shadow: 0 2px 6px #000; }
.acc { color: #f59e0b; }
.stats { display: flex; align-items: center; gap: 14px; }
.score { font: 800 20px/1 ui-monospace, monospace; color: #38bdf8; text-shadow: 0 2px 6px #000; }
.lives { letter-spacing: 2px; font-size: 18px; }
.life { color: #ef4444; text-shadow: 0 2px 6px #000; }
.life.gone { color: #334155; }
.mute { pointer-events: auto; background: rgba(17,26,51,.7); border: 1px solid #2a3a5e; border-radius: 8px; font-size: 15px; padding: 4px 8px; cursor: pointer; }
.overlay { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(8,12,28,.55); backdrop-filter: blur(3px); pointer-events: auto; }
.panel { text-align: center; max-width: 30rem; padding: 1.6rem 1.8rem; background: linear-gradient(180deg,#111a33,#0e1730); border: 1px solid #2a3a5e; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.panel h1 { font-size: clamp(1.6rem,6vw,2.4rem); margin: 0 0 .5rem; letter-spacing: 1px; }
.panel h1.win { color: #34d399; } .panel h1.lose { color: #f87171; }
.panel p { color: #cbd5e1; margin: .35rem 0; }
.panel .keys { color: #94a3b8; font-size: .9rem; }
.cta { margin-top: 1rem; padding: .7rem 1.6rem; font-size: 1.1rem; font-weight: 800; border: 0; border-radius: 10px; background: #f59e0b; color: #251803; cursor: pointer; box-shadow: 0 6px 18px rgba(245,158,11,.4); }
.cta:active { transform: translateY(1px); }
.touch { position: absolute; inset: auto 0 0 0; display: flex; justify-content: space-between; align-items: flex-end; padding: 20px; pointer-events: none; }
.dpad { position: relative; width: 156px; height: 156px; pointer-events: none; }
.tb { pointer-events: auto; position: absolute; width: 52px; height: 52px; border-radius: 12px; border: 1px solid #2a3a5e; background: rgba(17,26,51,.6); color: #e5e7eb; font-size: 18px; touch-action: none; user-select: none; -webkit-user-select: none; cursor: pointer; }
.tb:active { background: rgba(56,189,248,.5); }
.dpad .up { left: 52px; top: 0; } .dpad .down { left: 52px; top: 104px; }
.dpad .left { left: 0; top: 52px; } .dpad .right { left: 104px; top: 52px; }
.jump { pointer-events: auto; width: 96px; height: 96px; border-radius: 50%; font-weight: 900; font-size: 15px; background: rgba(245,158,11,.55); border: 1px solid #b45309; }
@media (hover: hover) and (pointer: fine) { .touch { opacity: .35; } }
`;
