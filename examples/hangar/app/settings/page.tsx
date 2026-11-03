import { Settings } from "./settings.tsx";
import { windowTitle } from "../../lib/tray.ts";

// The page's title is its window's title (the system WebView keeps them in step).
export const metadata = { title: windowTitle("/settings") };

export default function SettingsPage() {
  return <Settings />;
}
