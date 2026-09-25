// The SPA entry: mount the app, then tell the native side the UI is up.
import { createRoot } from "denext/client";
import { hideSplash, otaBooted, SAFE_AREA_CSS } from "denext/mobile";
import { App } from "./app.tsx";
import "./styles.css";

const style = document.createElement("style");
style.textContent = SAFE_AREA_CSS;
document.head.append(style);

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);

// capacitor.config.json sets SplashScreen.launchAutoHide: false, so the app hides the splash
// once it has drawn. otaBooted() confirms an over-the-air UI to the native watchdog (a UI
// that never calls it is rolled back); both do nothing on the web.
requestAnimationFrame(() => {
  void hideSplash();
  void otaBooted();
});
