// Permissions, local notifications, biometrics, geolocation, tracking, app review and the
// media library: the capabilities that talk to the OS.
import { useState } from "denext";
import {
  authenticateBiometric,
  getCurrentPosition,
  getTrackingStatus,
  isBiometricAvailable,
  openAppSettings,
  pendingNotifications,
  type PermissionName,
  requestReview,
  requestTrackingPermission,
  saveToLibrary,
  scheduleNotification,
  secureStore,
  setNotificationCategories,
  usePermission,
  watchPosition,
} from "denext/mobile";
import { Button, Output, useRun } from "../ui.tsx";
import type { Inbox } from "../app.tsx";
import { Screen } from "./shell.tsx";

function PermissionRow({ name }: { name: PermissionName }) {
  const p = usePermission(name);
  return (
    <div class="row btn-row">
      <span style={{ minWidth: "7rem" }}>{name}</span>
      <strong>
        {p.status ?? (p.error ? `error: ${p.error.message}` : "…")}
      </strong>
      <Button label="Request" onClick={() => p.request()} />
    </div>
  );
}

export function PermissionsScreen() {
  const [out, run] = useRun();
  return (
    <Screen
      title="Permissions"
      todo="Each row shows a status (prompt on a fresh install). 'Request' shows the iOS prompt ONCE; the status changes to granted, limited or blocked. Pressing Request again on a refused one shows no prompt (blocked). 'Open settings' opens this app's page in Settings; change one and come back: the row updates."
    >
      {(["camera", "photos", "location", "notifications"] as const).map((n) => (
        <PermissionRow key={n} name={n} />
      ))}
      <Button label="Open settings" onClick={() => run(openAppSettings)} />
      <Output value={out} />
    </Screen>
  );
}

const NOTIFY_CATEGORY = "denext-reply";

export function NotificationsScreen({ inbox }: { inbox: Inbox }) {
  const [out, run] = useRun();
  const schedule = () =>
    run(async () => {
      await setNotificationCategories([{
        id: NOTIFY_CATEGORY,
        actions: [
          { id: "open", title: "Open", foreground: true },
          { id: "dismiss", title: "Dismiss", destructive: true },
        ],
      }]);
      const id = await scheduleNotification({
        title: "denext local notification",
        body: "Long-press for actions, or tap to open /detail/local",
        trigger: { type: "interval", seconds: 10 },
        categoryId: NOTIFY_CATEGORY,
        data: { path: "/detail/local" },
      });
      return `scheduled id ${id}; lock the phone or go home now`;
    });
  return (
    <Screen
      title="Local notifications"
      todo="Grant notifications (Permissions screen) first. 'Schedule in 10 s', then press the side button or go home. After 10 s the banner appears. Long-press it: 'Open' and 'Dismiss' actions show. Tap the banner (or 'Open'): the app opens on /detail/local; come back here and 'Last tap' shows the actionId (tap or open) and data.path."
    >
      <div class="row btn-row">
        <Button label="Schedule in 10 s" onClick={schedule} />
        <Button label="Pending" onClick={() => run(pendingNotifications)} />
      </div>
      <Output value={out} />
      <p class="label">Last tap:</p>
      <pre class="out">{inbox.localTap ? JSON.stringify(inbox.localTap, null, 2) : "none yet"}</pre>
    </Screen>
  );
}

export function BiometricsScreen() {
  const [value, setValue] = useState(
    "secret-" + Math.floor(Math.random() * 1000),
  );
  const [out, run] = useRun();
  return (
    <Screen
      title="Biometrics"
      todo="'Available?' shows available: true, type: face. 'Authenticate' shows Face ID: look at the phone, the result says 'verified'; cancel it and the result says Error [cancelled]. 'Store (biometric)' then 'Read (biometric)': Face ID appears again and the result is the stored value."
    >
      <input value={value} onInput={(e) => setValue(e.currentTarget.value)} />
      <div class="row btn-row">
        <Button label="Available?" onClick={() => run(isBiometricAvailable)} />
        <Button
          label="Authenticate"
          onClick={() =>
            run(() =>
              authenticateBiometric({ reason: "Test denext biometrics" }).then(
                () => "verified",
              )
            )}
        />
        <Button
          label="Store (biometric)"
          onClick={() =>
            run(() =>
              secureStore.set("bio-demo", value, { requireBiometric: true })
                .then(() => `stored "${value}"`)
            )}
        />
        <Button
          label="Read (biometric)"
          onClick={() =>
            run(() =>
              secureStore.get("bio-demo", {
                reason: "Read the biometric-gated secret",
              })
            )}
        />
      </div>
      <Output value={out} />
    </Screen>
  );
}

export function GeolocationScreen() {
  const [out, run] = useRun();
  const [watch, setWatch] = useState<{ stop: () => void } | null>(null);
  const [ticks, setTicks] = useState<string>("");
  const toggleWatch = () => {
    if (watch) {
      watch.stop();
      setWatch(null);
      return;
    }
    let n = 0;
    const stop = watchPosition(
      (p) =>
        setTicks(
          `#${++n} ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)} ±${
            Math.round(p.accuracy)
          } m`,
        ),
      { accuracy: "high" },
      (e) => setTicks(`Error [${e.code}]: ${e.message}`),
    );
    setWatch({ stop });
  };
  return (
    <Screen
      title="Geolocation"
      todo="'Current position' (the first time shows the location prompt: allow While Using): the result shows your latitude/longitude and an accuracy in metres. 'Start watch': the line updates (#1, #2…) as you move or every few seconds; 'Stop watch' stops it (the location arrow in the status bar goes away)."
    >
      <div class="row btn-row">
        <Button
          label="Current position"
          onClick={() => run(() => getCurrentPosition({ accuracy: "high" }))}
        />
        <Button
          label={watch ? "Stop watch" : "Start watch"}
          onClick={toggleWatch}
        />
      </div>
      <pre class="out">{ticks || "not watching"}</pre>
      <Output value={out} />
    </Screen>
  );
}

/** A 512×512 PNG drawn on a canvas, as a data: URL. */
function generatedImage(): string {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 512, 512);
  grad.addColorStop(0, "#6d28d9");
  grad.addColorStop(1, "#0ea5e9");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = "white";
  g.font = "bold 56px system-ui";
  g.fillText("denext 2.11", 70, 250);
  g.font = "28px system-ui";
  g.fillText(new Date().toLocaleString(), 70, 310);
  return c.toDataURL("image/png");
}

export function StoreScreen() {
  const [out, run] = useRun();
  return (
    <Screen
      title="Tracking · Review · Media"
      todo="'Tracking status' shows notDetermined (fresh install). 'Request tracking' shows the App Tracking Transparency prompt once; the status becomes authorized or denied. 'Request review' shows the rating sheet (debug builds only; iOS may throttle it). 'Save image to Photos' asks for add-only Photos access, then a purple 'denext 2.11' image with today's time is the newest item in Photos."
    >
      <div class="row btn-row">
        <Button
          label="Tracking status"
          onClick={() => run(getTrackingStatus)}
        />
        <Button
          label="Request tracking"
          onClick={() => run(requestTrackingPermission)}
        />
      </div>
      <div class="row btn-row">
        <Button label="Request review" onClick={() => run(requestReview)} />
        <Button
          label="Save image to Photos"
          onClick={() =>
            run(() => saveToLibrary(generatedImage(), { fileName: "denext-2-11.png" }))}
        />
      </div>
      <Output value={out} />
    </Screen>
  );
}
