"use client";
// The manual release checks (CONTRIBUTING.md › "Manual desktop checks before a final release") that
// need a person at the screen: a real passkey ceremony (Windows Hello / Touch ID), the Windows 11
// backdrops, and HiDPI geometry. Nothing here runs by itself: the panel is shown only when the app
// was opened by hand (never under `deno task test:window`), and every action is a button.

import { useEffect, useRef, useState } from "denext";
import { desktopExtension } from "denext/desktop/client";
import {
  getScreens,
  getWindowState,
  onDisplayChanged,
  onWindowStateChange,
  setWindowBackdrop,
  setWindowBounds,
  type WindowBackdrop,
  type WindowBounds,
  windowCapabilities,
  type WindowScreen,
  type WindowState,
} from "denext/desktop/window";

/** Where the last created credential id (per RP) and the saved window placement are kept. */
const credentialKey = (rpId: string) => `kitchen-manual-credential:${rpId}`;
const PLACEMENT_KEY = "kitchen-manual-placement";

// deno-lint-ignore no-explicit-any
const passkeys = desktopExtension("passkeys") as unknown as Record<string, (a?: unknown) => any>;

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable: the checks still work within this launch
  }
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");
}

const challenge = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

type Outcome = { readonly ok: boolean; readonly text: string } | null;

function Result({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null;
  return <pre class="manual-result" data-ok={String(outcome.ok)}>{outcome.text}</pre>;
}

/**
 * Passkey: create, then sign in, through the `passkeys` capability (webauthn.dll / ASAuthorization),
 * for an RP ID that defaults to the first one `desktop.capabilities.passkeys.rpIds` pins.
 */
function PasskeyCheck({ rpIds }: { rpIds: readonly string[] }) {
  const [caps, setCaps] = useState("…");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [rpId, setRpId] = useState(rpIds[0] ?? "");
  const [credential, setCredential] = useState<string | null>(() =>
    store(credentialKey(rpIds[0] ?? ""))
  );

  const chooseRp = (next: string) => {
    const id = next.trim().toLowerCase();
    setRpId(id);
    setCredential(store(credentialKey(id)));
    setOutcome(null);
  };

  useEffect(() => {
    passkeys.capabilities({}).then(
      (c: { available: boolean; platformAuthenticator: boolean; securityKeys: boolean }) =>
        setCaps(
          `native path: ${c.available ? "yes" : "no"} · platform authenticator (Windows Hello / ` +
            `Touch ID) ready: ${c.platformAuthenticator ? "YES" : "NO"} · security keys: ${
              c.securityKeys ? "yes" : "no"
            }`,
        ),
      (err: unknown) => setCaps(`capabilities() failed: ${message(err)}`),
    );
  }, []);

  const ceremony = async (kind: "create" | "get") => {
    setBusy(true);
    setOutcome({ ok: true, text: "Waiting for the OS dialog…" });
    const options = kind === "create"
      ? {
        rp: { id: rpId, name: "denext manual check" },
        user: {
          id: b64url(crypto.getRandomValues(new Uint8Array(16))),
          name: "denext-manual-check",
          displayName: "denext manual check",
        },
        challenge: challenge(),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          userVerification: "required",
        },
        attestation: "none",
        timeout: 120_000,
      }
      : {
        rpId,
        challenge: challenge(),
        userVerification: "required",
        timeout: 120_000,
        ...(credential ? { allowCredentials: [{ type: "public-key", id: credential }] } : {}),
      };
    try {
      const envelope = await passkeys[kind]({ optionsJson: JSON.stringify(options) });
      if (envelope?.ok) {
        const c = envelope.credential as { id?: string; type?: string };
        if (kind === "create" && c.id) setCredential(store(credentialKey(rpId), c.id) ?? c.id);
        setOutcome({
          ok: true,
          text: `SUCCESS (${kind === "create" ? "passkey created" : "signed in"})\n` +
            `credential id: ${c.id}\n` +
            (kind === "get" && credential && c.id !== credential
              ? "note: not the credential created last (a discoverable pick)\n"
              : "") +
            JSON.stringify(envelope.credential, null, 2).slice(0, 1500),
        });
      } else {
        setOutcome({
          ok: false,
          text: `FAILED: ${envelope?.error?.code ?? "?"}\n${envelope?.error?.message ?? ""}`,
        });
      }
    } catch (err) {
      setOutcome({ ok: false, text: `FAILED (bridge): ${message(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="manual-card">
      <h3>1. Passkey (Windows Hello / Touch ID)</h3>
      <p>
        Pick the relying party (one of{" "}
        <code>desktop.capabilities.passkeys.rpIds</code>; any other answers{" "}
        <code>invalid_rp</code>). Click{" "}
        <b>Create passkey</b>, approve it in the OS dialog (PIN, face or fingerprint), then click
        {" "}
        <b>Sign in with passkey</b>{" "}
        and approve again. Both must say SUCCESS, with the same credential id.
      </p>
      <label class="manual-facts">
        Relying party{" "}
        <input
          type="text"
          list="manual-rp-ids"
          value={rpId}
          disabled={busy}
          spellcheck={false}
          onChange={(e) => chooseRp(e.currentTarget.value)}
        />
        <datalist id="manual-rp-ids">
          {rpIds.map((id) => <option key={id} value={id} />)}
        </datalist>
      </label>
      <p class="manual-facts">{caps}</p>
      <p class="manual-facts">
        Last created credential: <code>{credential ?? "none yet"}</code>
      </p>
      <div class="manual-buttons">
        <button
          type="button"
          class="big"
          disabled={busy || !rpId}
          onClick={() => ceremony("create")}
        >
          Create passkey
        </button>
        <button type="button" class="big" disabled={busy || !rpId} onClick={() => ceremony("get")}>
          Sign in with passkey
        </button>
      </div>
      <Result outcome={outcome} />
    </section>
  );
}

const BACKDROPS: readonly WindowBackdrop[] = ["none", "mica", "acrylic", "tabbed", "vibrancy"];

/** Backdrop: Mica / Acrylic / tabbed (Windows 11), vibrancy (macOS). */
function BackdropCheck() {
  const [caps, setCaps] = useState<Record<string, boolean> | null>(null);
  const [current, setCurrent] = useState<string>("none");
  const [outcome, setOutcome] = useState<Outcome>(null);

  useEffect(() => {
    windowCapabilities().then(
      (c) => setCaps({ ...c }),
      (err: unknown) => setOutcome({ ok: false, text: `windowCapabilities(): ${message(err)}` }),
    );
    return () => {
      document.documentElement.removeAttribute("data-backdrop");
    };
  }, []);

  const apply = async (backdrop: WindowBackdrop) => {
    try {
      const applied = await setWindowBackdrop(backdrop);
      // The backdrop shows only where the page is transparent: clear the page's own background.
      if (applied && backdrop !== "none") {
        document.documentElement.setAttribute("data-backdrop", backdrop);
      } else document.documentElement.removeAttribute("data-backdrop");
      setCurrent(applied ? backdrop : "none");
      setOutcome({
        ok: applied,
        text: `setWindowBackdrop("${backdrop}") → ${applied ? "applied" : "NOT applied"}`,
      });
    } catch (err) {
      setOutcome({ ok: false, text: `setWindowBackdrop("${backdrop}") threw: ${message(err)}` });
    }
  };

  return (
    <section class="manual-card">
      <h3>2. Backdrop (Mica / Acrylic)</h3>
      <p>
        Each button sets the window backdrop and makes this page transparent, so the{" "}
        <b>whole window background should change</b>: Mica is a soft tint of the desktop wallpaper,
        Acrylic a stronger frosted blur of what is behind the window, tabbed a darker Mica. Move the
        window over something colourful, and click another window to see the inactive look.{" "}
        <b>none</b> restores the solid background.
      </p>
      <p class="manual-facts">
        The OS reports: {caps
          ? BACKDROPS.filter((b) => b !== "none").map((b) => `${b}: ${caps[b] ? "yes" : "no"}`)
            .join(" · ")
          : "…"} · current: <b>{current}</b>
      </p>
      <div class="manual-buttons">
        {BACKDROPS.filter((b) => b !== "vibrancy" || caps?.vibrancy).map((b) => (
          <button
            type="button"
            class="big"
            key={b}
            onClick={() => apply(b)}
          >
            {b}
          </button>
        ))}
      </div>
      <Result outcome={outcome} />
      {caps && (
        <details>
          <summary>windowCapabilities()</summary>
          <pre class="manual-result">{JSON.stringify(caps, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

interface Geometry {
  readonly dpr: number;
  readonly inner: string;
  readonly state: WindowState | null;
  readonly screens: readonly WindowScreen[];
  readonly at: string;
}

const box = (b: WindowBounds | null | undefined) =>
  b ? `${b.width}×${b.height} at (${b.x}, ${b.y})` : "null";

/** HiDPI: the scale facts, live, a crisp-line test pattern, and save / restore of the placement. */
function HiDpiCheck() {
  const [geo, setGeo] = useState<Geometry | null>(null);
  const [saved, setSaved] = useState<string | null>(() => store(PLACEMENT_KEY));
  const [outcome, setOutcome] = useState<Outcome>(null);

  const refresh = async () => {
    const [state, screens] = await Promise.all([
      getWindowState().catch(() => null),
      getScreens().catch(() => [] as WindowScreen[]),
    ]);
    setGeo({
      dpr: devicePixelRatio,
      inner: `${innerWidth}×${innerHeight}`,
      state,
      screens,
      at: new Date().toLocaleTimeString(),
    });
  };

  useEffect(() => {
    void refresh();
    const onResize = () => void refresh();
    addEventListener("resize", onResize);
    // devicePixelRatio changes when the window moves to a display with another scale.
    let media = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    const onDpr = () => {
      media.removeEventListener("change", onDpr);
      media = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      media.addEventListener("change", onDpr);
      void refresh();
    };
    media.addEventListener("change", onDpr);
    const stopState = onWindowStateChange(() => void refresh());
    const stopDisplays = onDisplayChanged(() => void refresh());
    // Moving the window fires no page event: poll while the panel is open.
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      removeEventListener("resize", onResize);
      media.removeEventListener("change", onDpr);
      stopState();
      stopDisplays();
      clearInterval(timer);
    };
  }, []);

  const save = async () => {
    const st = await getWindowState();
    const b = st.normalBounds ?? st.bounds;
    if (!b) return setOutcome({ ok: false, text: "the runtime reports no bounds" });
    setSaved(store(PLACEMENT_KEY, JSON.stringify(b)) ?? JSON.stringify(b));
    setOutcome({ ok: true, text: `saved ${box(b)}` });
  };

  const restore = async () => {
    if (!saved) return setOutcome({ ok: false, text: "nothing saved yet" });
    const want = JSON.parse(saved) as WindowBounds;
    try {
      await setWindowBounds(want);
      await new Promise((r) => setTimeout(r, 300));
      const st = await getWindowState();
      const got = st.normalBounds ?? st.bounds;
      const same = !!got && (["x", "y", "width", "height"] as const)
        .every((k) => Math.abs(got[k] - want[k]) <= 2);
      setOutcome({
        ok: same,
        text: `asked ${box(want)}\n  got ${box(got)}${same ? "  (match)" : "  (MISMATCH)"}`,
      });
    } catch (err) {
      setOutcome({ ok: false, text: `setWindowBounds threw: ${message(err)}` });
    }
  };

  // The pattern is drawn in DEVICE pixels (the canvas backing store is css size × dpr), so it is
  // sharp exactly when the webview maps one canvas pixel to one screen pixel.
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const dpr = geo?.dpr;
  useEffect(() => {
    const el = canvas.current;
    if (!el || !dpr) return;
    const cssW = 360, cssH = 96;
    el.style.width = `${cssW}px`;
    el.style.height = `${cssH}px`;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    el.width = w;
    el.height = h;
    const g = el.getContext("2d");
    if (!g) return;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#000";
    const third = Math.floor(w / 3);
    for (let y = 0; y < h; y += 2) g.fillRect(0, y, third, 1); // horizontal 1px lines
    for (let x = third; x < 2 * third; x += 2) g.fillRect(x, 0, 1, h); // vertical 1px lines
    for (let y = 0; y < h; y++) { // 1px checkerboard
      for (let x = 2 * third + (y % 2); x < w; x += 2) g.fillRect(x, y, 1, 1);
    }
  }, [dpr]);

  const st = geo?.state;
  return (
    <section class="manual-card">
      <h3>3. HiDPI</h3>
      <p>
        The lines below must be <b>sharp</b>{" "}
        (no grey smear, the 1px checkerboard an even grid) and the text crisp, at every Windows
        display scale (Settings › Display › Scale: 100%, 150%, 200%) and on every monitor. Drag the
        window to another monitor or change the scale: the numbers update. Then{" "}
        <b>Save placement</b>, move / resize the window (or move it to the other monitor), and click
        {" "}
        <b>Restore placement</b>: it must come back to the same size and place.
      </p>
      <canvas class="hidpi-canvas" ref={canvas} aria-label="1 device pixel line test pattern" />
      <div class="hidpi-text">
        <span class="t11">11px The quick brown fox jumps over the lazy dog 0123456789</span>
        <span class="t14">14px The quick brown fox jumps over the lazy dog</span>
        <span class="t20">20px Sphinx of black quartz, judge my vow</span>
      </div>
      <table class="manual-facts">
        <tbody>
          <tr>
            <td>devicePixelRatio</td>
            <td>
              <b>{geo?.dpr ?? "…"}</b> (page {geo?.inner ?? "…"} CSS px)
            </td>
          </tr>
          <tr>
            <td>window frame</td>
            <td>{box(st?.bounds)}</td>
          </tr>
          <tr>
            <td>page area</td>
            <td>{box(st?.contentBounds)}</td>
          </tr>
          <tr>
            <td>normal bounds</td>
            <td>{box(st?.normalBounds)}</td>
          </tr>
          <tr>
            <td>on screen</td>
            <td>
              {st?.screen
                ? `#${st.screen.id} scale ${st.screen.scaleFactor} ${box(st.screen.bounds)}`
                : "null"}
            </td>
          </tr>
          {(geo?.screens ?? []).map((s) => (
            <tr key={s.id}>
              <td>screen #{s.id}{s.isPrimary ? " (primary)" : ""}</td>
              <td>
                scale <b>{s.scaleFactor}</b> · {box(s.bounds)} · work area {box(s.workArea)}
              </td>
            </tr>
          ))}
          <tr>
            <td>saved placement</td>
            <td>{saved ? box(JSON.parse(saved)) : "none"}</td>
          </tr>
          <tr>
            <td>updated</td>
            <td>{geo?.at ?? "…"}</td>
          </tr>
        </tbody>
      </table>
      <div class="manual-buttons">
        <button type="button" class="big" onClick={() => save()}>Save placement</button>
        <button type="button" class="big" onClick={() => restore()}>Restore placement</button>
      </div>
      <Result outcome={outcome} />
    </section>
  );
}

/**
 * The manual checks panel (rendered by the kitchen sink only when it was opened by hand).
 *
 * @param rpIds The RP IDs the `passkeys` capability pins (the passkey check defaults to the first).
 */
export function ManualChecks({ rpIds }: { rpIds: readonly string[] }) {
  return (
    <details class="manual" open>
      <summary>Manual release checks (passkey, backdrop, HiDPI)</summary>
      <PasskeyCheck rpIds={rpIds} />
      <BackdropCheck />
      <HiDpiCheck />
    </details>
  );
}
