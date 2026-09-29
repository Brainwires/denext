// Safe area + system bars, orientation, and the privacy screen.
import { useEffect, useRef, useState } from "denext";
import {
  lockOrientation,
  setPrivacyScreen,
  setSystemBars,
  unlockOrientation,
  useOrientation,
  useSafeAreaInsets,
  useSystemBarsFollowTheme,
} from "denext/mobile";
import { Button, Output, useRun } from "../ui.tsx";
import { Screen } from "./shell.tsx";

function FollowTheme() {
  useSystemBarsFollowTheme();
  return (
    <p class="note">
      useSystemBarsFollowTheme() is ON: the status bar follows light/dark.
    </p>
  );
}

export function SafeAreaScreen() {
  const insets = useSafeAreaInsets();
  const [follow, setFollow] = useState(false);
  const [out, run] = useRun();
  return (
    <Screen
      title="Safe area & system bars"
      todo="The insets readout shows top ≥ 47 and bottom ≈ 34 on a Face ID iPhone. The bar pinned to the bottom has its text fully above the home indicator line and says OK. 'Light text' makes the status bar text white, 'Dark text' black, 'Hide' hides it, 'Show' brings it back. Turn on 'Follow theme' and switch the phone between Light and Dark mode in Control Center: the status bar text flips to stay readable."
    >
      <pre class="out">{JSON.stringify(insets)}</pre>
      <div class="row btn-row">
        <Button
          label="Light text"
          onClick={() => run(() => setSystemBars({ style: "dark" }))}
        />
        <Button
          label="Dark text"
          onClick={() => run(() => setSystemBars({ style: "light" }))}
        />
        <Button
          label="Hide"
          onClick={() => run(() => setSystemBars({ hidden: true }))}
        />
        <Button
          label="Show"
          onClick={() => run(() => setSystemBars({ hidden: false }))}
        />
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          checked={follow}
          onChange={(e) => setFollow(e.currentTarget.checked)}
        />
        Follow theme
      </label>
      {follow && <FollowTheme />}
      <p class="note">
        setSystemBars style names the BACKGROUND: "dark" = dark bar with light text (Capacitor's
        SystemBars convention).
      </p>
      <Output value={out} />
      <div style={{ height: "72px" }} />
      <BottomBar insetBottom={insets.bottom} />
    </Screen>
  );
}

/**
 * A bar pinned to the bottom edge that pads itself by the bottom inset, so its content sits
 * above the home indicator. The readout measures where that content ends.
 */
function BottomBar({ insetBottom }: { insetBottom: number }) {
  const content = useRef<HTMLDivElement | null>(null);
  const [gap, setGap] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = content.current;
      if (el) setGap(Math.round(innerHeight - insetBottom - el.getBoundingClientRect().bottom));
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [insetBottom]);
  const ok = gap !== null && gap >= 0;
  return (
    <div class="bottom-bar" data-selftest="bottom-bar">
      <div ref={content} data-selftest="bottom-bar-content">
        Bottom bar: must sit fully ABOVE the home indicator.{" "}
        <strong>{gap === null ? "…" : ok ? `OK (${gap}px clear)` : `OVERLAPS by ${-gap}px`}</strong>
        {" "}
        · inset bottom {insetBottom}
      </div>
    </div>
  );
}

export function OrientationScreen() {
  const orientation = useOrientation();
  const [out, run] = useRun();
  return (
    <Screen
      title="Orientation"
      todo="'Lock portrait', then turn the phone sideways: the UI stays portrait. 'Lock landscape': the UI rotates to landscape at once and stays there. 'Unlock': it follows the phone again. The readout updates on every rotation."
    >
      <p>
        useOrientation(): <strong>{orientation}</strong>
      </p>
      <div class="row btn-row">
        <Button
          label="Lock portrait"
          onClick={() => run(() => lockOrientation("portrait"))}
        />
        <Button
          label="Lock landscape"
          onClick={() => run(() => lockOrientation("landscape"))}
        />
        <Button label="Unlock" onClick={() => run(unlockOrientation)} />
      </div>
      <Output value={out} />
    </Screen>
  );
}

export function PrivacyScreen() {
  const [on, setOn] = useState(false);
  const [out, run] = useRun();
  const toggle = (next: boolean) =>
    run(() =>
      setPrivacyScreen(next, { iosBlur: "light" }).then(
        () => (setOn(next), `on: ${next}`),
      )
    );
  return (
    <Screen
      title="Privacy screen"
      todo="Turn it ON, then swipe up to the app switcher: this app's card is blurred. Turn it OFF and repeat: the card shows the UI."
    >
      <p>
        Privacy screen: <strong>{on ? "ON" : "OFF"}</strong>
      </p>
      <div class="row btn-row">
        <Button label="Turn on" onClick={() => toggle(true)} />
        <Button label="Turn off" onClick={() => toggle(false)} />
      </div>
      <Output value={out} />
    </Screen>
  );
}
