// The SPA entry: mount the app, then tell the native side the UI is up.
import { createRoot } from "denext/client";
import { hideSplash, otaBooted } from "denext/mobile";
import { App } from "./app.tsx";
import "./styles.css";

// `?selftest` at boot (or the deep link denextmobile://selftest) runs the automatic self-test.
if (new URLSearchParams(location.search).has("selftest")) {
  history.replaceState(null, "", "/selftest");
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);

// capacitor.config.json sets SplashScreen.launchAutoHide: false, so the app hides the splash
// once it has drawn. otaBooted() confirms an over-the-air UI to the native watchdog (a UI
// that never calls it is rolled back); both do nothing on the web.
requestAnimationFrame(() => {
  void hideSplash();
  void otaBooted();
});
