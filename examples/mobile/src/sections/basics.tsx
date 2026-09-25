// Device basics: haptics, clipboard, share, device info, network, keep-awake, splash and
// the secure store. Each works on the web too, through its fallback.
import { useState } from "denext";
import {
  deviceInfo,
  haptic,
  type HapticKind,
  hideSplash,
  readClipboard,
  secureStore,
  share,
  useKeepAwake,
  useNetworkStatus,
  writeClipboard,
} from "denext/mobile";
import { Button, Output, Section, useRun } from "../ui.tsx";

const HAPTICS: HapticKind[] = [
  "light",
  "medium",
  "heavy",
  "success",
  "warning",
  "error",
  "selection",
];

function Haptics() {
  const [out, run] = useRun();
  return (
    <Section
      title="Haptics"
      note="haptic(kind): the Taptic Engine natively, navigator.vibrate on the web."
    >
      <div class="row">
        {HAPTICS.map((kind) => (
          <Button
            key={kind}
            label={kind}
            onClick={() => run(() => haptic(kind).then(() => `played ${kind}`))}
          />
        ))}
      </div>
      <Output value={out} />
    </Section>
  );
}

function Clipboard() {
  const [text, setText] = useState("Hello from denext mobile");
  const [out, run] = useRun();
  return (
    <Section title="Clipboard">
      <input value={text} onInput={(e) => setText(e.currentTarget.value)} />
      <div class="row">
        <Button
          label="Write"
          onClick={() => run(() => writeClipboard(text).then(() => `wrote "${text}"`))}
        />
        <Button label="Read" onClick={() => run(readClipboard)} />
      </div>
      <Output value={out} />
    </Section>
  );
}

function Share() {
  const [out, run] = useRun();
  const payload = {
    title: "denext mobile",
    text: "Shared from the kitchen sink",
    url: "https://denext.dev",
  };
  return (
    <Section
      title="Share"
      note='The system share sheet; the result is "shared", "copied" or "cancelled".'
    >
      <Button label="Share a link" onClick={() => run(() => share(payload))} />
      <Output value={out} />
    </Section>
  );
}

function Device() {
  const [out, run] = useRun();
  const network = useNetworkStatus();
  return (
    <Section title="Device and network">
      <p>
        useNetworkStatus(): <strong>{network.connected ? "online" : "offline"}</strong>{" "}
        ({network.connectionType})
      </p>
      <Button label="deviceInfo()" onClick={() => run(deviceInfo)} />
      <Output value={out} />
    </Section>
  );
}

function KeepAwake() {
  const [awake, setAwake] = useState(false);
  useKeepAwake(awake);
  return (
    <Section
      title="Keep awake"
      note="useKeepAwake(active): the screen stays on while this is on."
    >
      <label class="toggle">
        <input
          type="checkbox"
          checked={awake}
          onChange={() => setAwake(!awake)}
        />
        Keep the screen on: <strong>{awake ? "yes" : "no"}</strong>
      </label>
    </Section>
  );
}

function Splash() {
  const [out, run] = useRun();
  return (
    <Section
      title="Splash screen"
      note="launchAutoHide is false, so src/main.tsx calls hideSplash() after the first frame. Calling it again is harmless."
    >
      <Button
        label="hideSplash()"
        onClick={() => run(() => hideSplash().then(() => "hidden"))}
      />
      <Output value={out} />
    </Section>
  );
}

function SecureStore() {
  const [key, setKey] = useState("token");
  const [value, setValue] = useState("s3cret");
  const [out, run] = useRun();
  return (
    <Section
      title="Secure store"
      note="Keychain / Keystore natively; a plain IndexedDB store (NOT secret) on the web."
    >
      <div class="row">
        <input value={key} onInput={(e) => setKey(e.currentTarget.value)} />
        <input value={value} onInput={(e) => setValue(e.currentTarget.value)} />
      </div>
      <div class="row">
        <Button
          label="Set"
          onClick={() => run(() => secureStore.set(key, value).then(() => `set ${key}`))}
        />
        <Button label="Get" onClick={() => run(() => secureStore.get(key))} />
        <Button
          label="Delete"
          onClick={() => run(() => secureStore.delete(key).then(() => `deleted ${key}`))}
        />
      </div>
      <Output value={out} />
    </Section>
  );
}

export function Basics() {
  return (
    <>
      <Haptics />
      <Clipboard />
      <Share />
      <Device />
      <KeepAwake />
      <Splash />
      <SecureStore />
    </>
  );
}
